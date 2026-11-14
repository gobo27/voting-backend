
"use strict";

const bcrypt = require("bcryptjs");
const db = require("../../../config/db");
const { sendCredentialsEmail } = require("./emailjs.server");

const {
    saveAssignments,
    parseScopeIds
} = require("./admin.assignments.controller");

const ALLOWED_ROLES = [
    "adviser",
    "committee",
    "super_admin"
];

const clean = value =>
    typeof value === "string" ? value.trim() : "";

const validEmail = email =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const validId = id =>
    Number.isSafeInteger(Number(id)) && Number(id) > 0;

function validatePassword(password) {
    return typeof password === "string" &&
        password.length >= 9 &&
        Buffer.byteLength(password, "utf8") <= 72;
}

// Validate optional scope IDs
function getScopeInput(body, role) {
    const supplied = Object.prototype.hasOwnProperty.call(
        body || {},
        "scope_ids"
    );

    if (!supplied) {
        return {
            supplied: false,
            ids: []
        };
    }

    if (role !== "committee") {
        const error = new Error(
            "Department/grade assignments are only for Committee accounts."
        );
        error.status = 400;
        throw error;
    }

    const ids = parseScopeIds(body.scope_ids);

    if (!ids) {
        const error = new Error(
            "scope_ids must contain unique positive scope IDs."
        );
        error.status = 400;
        throw error;
    }

    return {
        supplied: true,
        ids
    };
}

// Lock current election kapag may assignment update
async function getLockedElection(conn) {
    const [rows] = await conn.execute(
        `SELECT
            election_id,
            title,
            school_level,
            status,
            is_active,
            is_current,
            archived_at
         FROM elections
         WHERE is_current = 1
           AND archived_at IS NULL
         LIMIT 1
         FOR UPDATE`
    );

    return rows[0] || null;
}

function createError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function accountError(res, label, error) {
    console.error(label, error);

    if (error.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
            message: "Email or assignment already exists."
        });
    }

    if (
        error.code === "ER_ROW_IS_REFERENCED_2" ||
        error.code === "ER_ROW_IS_REFERENCED"
    ) {
        return res.status(409).json({
            message:
                "This account has related records and cannot be deleted. Historical election records must be preserved."
        });
    }

    return res.status(error.status || 500).json({
        message: error.status
            ? error.message
            : "Database operation failed."
    });
}

// CREATE ACCOUNT
exports.createAccount = async (req, res) => {
    let conn;
    let transactionStarted = false;

    try {
        const name = clean(req.body?.name);
        const email = clean(req.body?.email).toLowerCase();
        const password = req.body?.password;
        const role = clean(req.body?.role).toLowerCase();

        if (!name || !email || !role || !password) {
            return res.status(400).json({
                message: "Please complete all fields."
            });
        }

        if (
            name.length > 100 ||
            email.length > 150 ||
            !validEmail(email)
        ) {
            return res.status(400).json({
                message: "Invalid name or email."
            });
        }

        if (!ALLOWED_ROLES.includes(role)) {
            return res.status(400).json({
                message: "Invalid account role."
            });
        }

        if (!validatePassword(password)) {
            return res.status(400).json({
                message:
                    "Temporary password must be at least 9 characters and at most 72 UTF-8 bytes."
            });
        }

        const scopeInput = getScopeInput(req.body, role);

        // Hash muna bago kumuha ng DB connection
        const hash = await bcrypt.hash(password, 12);

        conn = await db.getConnection();
        await conn.beginTransaction();
        transactionStarted = true;

        let election = null;

        // Election lock kapag may selected scopes
        if (scopeInput.supplied && scopeInput.ids.length) {
            election = await getLockedElection(conn);

            if (!election) {
                throw createError(
                    "No current election available for assignments.",
                    409
                );
            }
        }

        const [existing] = await conn.execute(
            `SELECT id
             FROM users
             WHERE email = ?
             LIMIT 1`,
            [email]
        );

        if (existing.length) {
            throw createError(
                "Email already exists.",
                409
            );
        }

        // Save account sa same transaction
        const [result] = await conn.execute(
            `INSERT INTO users
             (name, email, password, role, must_change_password)
             VALUES (?, ?, ?, ?, 1)`,
            [name, email, hash, role]
        );

        const userId = result.insertId;

        // Save Committee assignments atomically
        if (
            role === "committee" &&
            scopeInput.supplied &&
            scopeInput.ids.length
        ) {
            await saveAssignments(
                conn,
                userId,
                election,
                scopeInput.ids,
                req.user.id
            );
        }

        await conn.commit();
        transactionStarted = false;

        // Release connection bago mag-send ng email
        conn.release();
        conn = null;

        let emailSent = false;
        let emailRedirected = false;
        let emailError = null;

        // Email lang pagkatapos ma-commit ang account
        try {
            const sent = await sendCredentialsEmail({
                to: email,
                firstName: name,
                userName: name,
                password,
                role
            });

            emailSent = sent?.sent === true;
            emailRedirected = sent?.redirected === true;

            if (!emailSent) {
                emailError =
                    "Email service did not accept the message.";
            }

        } catch (error) {
            emailError = error.message;
            console.error("EMAILJS ERROR:", error);
        }

        return res.status(201).json({
            message: emailSent
                ? "Account created. Email accepted by EmailJS."
                : "Account created, but email sending failed.",
            emailSent,
            emailRedirected,
            ...(emailError ? { emailError } : {}),
            user: {
                id: userId,
                name,
                email,
                role
            },
            scope_ids: scopeInput.ids
        });

    } catch (error) {
        if (conn && transactionStarted) {
            try {
                await conn.rollback();
            } catch (rollbackError) {
                console.error(
                    "CREATE ACCOUNT ROLLBACK ERROR:",
                    rollbackError
                );
            }
        }

        return accountError(
            res,
            "CREATE ACCOUNT ERROR:",
            error
        );

    } finally {
        if (conn) conn.release();
    }
};

// GET ACCOUNTS
exports.getAccounts = async (req, res) => {
    try {
        const [users] = await db.execute(
            `SELECT
                u.id,
                u.name,
                u.email,
                u.role,

                GROUP_CONCAT(
                    DISTINCT CASE
                        WHEN e.election_id IS NOT NULL
                        THEN e.school_level
                    END
                    ORDER BY e.school_level
                    SEPARATOR ','
                ) AS assigned_school_levels,

                GROUP_CONCAT(
                    DISTINCT CASE
                        WHEN e.election_id IS NOT NULL
                        THEN es.scope_name
                    END
                    ORDER BY es.scope_name
                    SEPARATOR ', '
                ) AS assigned_scopes

             FROM users u

             LEFT JOIN committee_scope_assignments csa
                ON csa.committee_user_id = u.id
                AND csa.is_active = 1

             LEFT JOIN election_scopes es
                ON es.scope_id = csa.scope_id
                AND es.is_active = 1

             LEFT JOIN elections e
                ON e.election_id = es.election_id
                AND e.is_current = 1
                AND e.archived_at IS NULL

             WHERE u.role IN (
                'adviser',
                'committee',
                'super_admin'
             )

             GROUP BY
                u.id,
                u.name,
                u.email,
                u.role

             ORDER BY u.id DESC`
        );

        return res.json({ users });

    } catch (error) {
        return accountError(
            res,
            "GET ACCOUNTS ERROR:",
            error
        );
    }
};

// EDIT ACCOUNT
exports.updateAccount = async (req, res) => {
    let conn;
    let transactionStarted = false;

    try {
        const { id } = req.params;

        const name = clean(req.body?.name);
        const email = clean(req.body?.email).toLowerCase();
        const role = clean(req.body?.role).toLowerCase();
        const password = req.body?.password;

        if (!validId(id)) {
            return res.status(400).json({
                message: "Invalid account ID."
            });
        }

        if (
            !name ||
            !email ||
            !role ||
            name.length > 100 ||
            email.length > 150 ||
            !validEmail(email)
        ) {
            return res.status(400).json({
                message:
                    "Valid name, email and role are required."
            });
        }

        if (!ALLOWED_ROLES.includes(role)) {
            return res.status(400).json({
                message: "Invalid role."
            });
        }

        const scopeInput = getScopeInput(req.body, role);

        const changingPassword =
            password !== undefined &&
            password !== null &&
            password !== "";

        if (
            changingPassword &&
            !validatePassword(password)
        ) {
            return res.status(400).json({
                message:
                    "Temporary password must be at least 9 characters and at most 72 UTF-8 bytes."
            });
        }

        // Hash outside transaction para mas maikli DB lock
        const hash = changingPassword
            ? await bcrypt.hash(password, 12)
            : null;

        conn = await db.getConnection();
        await conn.beginTransaction();
        transactionStarted = true;

        let election = null;

        if (scopeInput.supplied) {
            election = await getLockedElection(conn);

            if (!election) {
                throw createError(
                    "No current election available.",
                    409
                );
            }
        }

        // Protect Super Admin accounts
        const [accounts] = await conn.execute(
            `SELECT id, role
             FROM users
             WHERE id = ?
             FOR UPDATE`,
            [Number(id)]
        );

        if (
            !accounts.length ||
            !["adviser", "committee"].includes(
                accounts[0].role
            )
        ) {
            throw createError(
                "Account not found or protected.",
                404
            );
        }

        const oldRole = accounts[0].role;

        // Huwag iwan ang Committee history sa ibang role
        if (
            oldRole === "committee" &&
            role !== "committee"
        ) {
            const [history] = await conn.execute(
                `SELECT assignment_id
                 FROM committee_scope_assignments
                 WHERE committee_user_id = ?
                 LIMIT 1`,
                [Number(id)]
            );

            if (history.length) {
                throw createError(
                    "This Committee account has assignment history. Revoke its assignments and preserve the account role for audit purposes.",
                    409
                );
            }
        }

        const [duplicate] = await conn.execute(
            `SELECT id
             FROM users
             WHERE email = ?
               AND id <> ?
             LIMIT 1`,
            [email, Number(id)]
        );

        if (duplicate.length) {
            throw createError(
                "Email already used by another account.",
                409
            );
        }

        // Preserve optional password update
        if (changingPassword) {
            await conn.execute(
                `UPDATE users
                 SET name = ?,
                     email = ?,
                     role = ?,
                     password = ?,
                     must_change_password = 1
                 WHERE id = ?
                   AND role IN ('adviser', 'committee')`,
                [name, email, role, hash, Number(id)]
            );

        } else {
            await conn.execute(
                `UPDATE users
                 SET name = ?,
                     email = ?,
                     role = ?
                 WHERE id = ?
                   AND role IN ('adviser', 'committee')`,
                [name, email, role, Number(id)]
            );
        }

        // Update selected Committee assignments
        if (role === "committee" && scopeInput.supplied) {
            await saveAssignments(
                conn,
                Number(id),
                election,
                scopeInput.ids,
                req.user.id
            );
        }

        await conn.commit();
        transactionStarted = false;

        return res.json({
            message: "Account updated successfully.",
            user: {
                id: Number(id),
                name,
                email,
                role
            },
            ...(scopeInput.supplied
                ? { scope_ids: scopeInput.ids }
                : {})
        });

    } catch (error) {
        if (conn && transactionStarted) {
            try {
                await conn.rollback();
            } catch (rollbackError) {
                console.error(
                    "UPDATE ACCOUNT ROLLBACK ERROR:",
                    rollbackError
                );
            }
        }

        return accountError(
            res,
            "UPDATE ACCOUNT ERROR:",
            error
        );

    } finally {
        if (conn) conn.release();
    }
};

// DELETE ACCOUNT
exports.deleteAccount = async (req, res) => {
    let conn;
    let transactionStarted = false;

    try {
        const { id } = req.params;

        if (!validId(id)) {
            return res.status(400).json({
                message: "Invalid account ID."
            });
        }

        const loggedInId =
            req.user?.id ??
            req.user?.user_id;

        if (!validId(loggedInId)) {
            return res.status(403).json({
                message:
                    "Unable to verify your account identity."
            });
        }

        if (Number(id) === Number(loggedInId)) {
            return res.status(403).json({
                message:
                    "You cannot delete your own account."
            });
        }

        conn = await db.getConnection();
        await conn.beginTransaction();
        transactionStarted = true;

        const [target] = await conn.execute(
            `SELECT id, role
             FROM users
             WHERE id = ?
             FOR UPDATE`,
            [Number(id)]
        );

        if (!target.length) {
            throw createError(
                "Account not found.",
                404
            );
        }

        if (!ALLOWED_ROLES.includes(target[0].role)) {
            throw createError(
                "This account cannot be deleted.",
                403
            );
        }

        // Huwag burahin ang last Super Admin
        if (target[0].role === "super_admin") {
            const [admins] = await conn.execute(
                `SELECT id
                 FROM users
                 WHERE role = 'super_admin'
                 ORDER BY id
                 FOR UPDATE`
            );

            if (admins.length <= 1) {
                throw createError(
                    "Cannot delete the last Super Admin.",
                    403
                );
            }
        }

        // Preserve historical Committee assignments
        const [committeeHistory] = await conn.execute(
            `SELECT assignment_id
             FROM committee_scope_assignments
             WHERE committee_user_id = ?
                OR assigned_by = ?
             LIMIT 1`,
            [Number(id), Number(id)]
        );

        const [adviserHistory] = await conn.execute(
            `SELECT assignment_id
             FROM election_adviser_assignments
             WHERE adviser_user_id = ?
                OR assigned_by = ?
             LIMIT 1`,
            [Number(id), Number(id)]
        );

        if (
            committeeHistory.length ||
            adviserHistory.length
        ) {
            throw createError(
                "This account has election assignment history and cannot be permanently deleted.",
                409
            );
        }

        const [result] = await conn.execute(
            `DELETE FROM users
             WHERE id = ?
               AND role IN (
                   'adviser',
                   'committee',
                   'super_admin'
               )`,
            [Number(id)]
        );

        if (!result.affectedRows) {
            throw createError(
                "Account not found.",
                404
            );
        }

        await conn.commit();
        transactionStarted = false;

        return res.json({
            message: "Account deleted successfully."
        });

    } catch (error) {
        if (conn && transactionStarted) {
            try {
                await conn.rollback();
            } catch (rollbackError) {
                console.error(
                    "DELETE ACCOUNT ROLLBACK ERROR:",
                    rollbackError
                );
            }
        }

        return accountError(
            res,
            "DELETE ACCOUNT ERROR:",
            error
        );

    } finally {
        if (conn) conn.release();
    }
};
