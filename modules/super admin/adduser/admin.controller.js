"use strict";

const bcrypt = require("bcryptjs");
const db = require("../../../config/db");
const { sendCredentialsEmail } = require("./resend.server");

const ALLOWED_ROLES = ["adviser", "committee", "super_admin"];

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

// CREATE ACCOUNT
exports.createAccount = async (req, res) => {
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
                message: "Temporary password must be at least 9 characters and at most 72 UTF-8 bytes."
            });
        }

        const [existing] = await db.execute(
            "SELECT id FROM users WHERE email = ? LIMIT 1",
            [email]
        );

        if (existing.length) {
            return res.status(409).json({
                message: "Email already exists."
            });
        }

        const hash = await bcrypt.hash(password, 12);

        const [result] = await db.execute(
            `INSERT INTO users
             (name, email, password, role, must_change_password)
             VALUES (?, ?, ?, ?, 1)`,
            [name, email, hash, role]
        );

        let emailSent = false;
        let emailRedirected = false;
        let emailError = null;

        try {
            const sent = await sendCredentialsEmail({
                to: email,
                firstName: name,
                userName: email,
                password,
                role
            });

            emailSent = sent?.sent === true;
            emailRedirected = sent?.redirected === true;

            if (!emailSent) {
                emailError = "Email service did not accept the message.";
            }
        } catch (error) {
            emailError = error.message;
            console.error("RESEND ERROR:", error);
        }

        return res.status(201).json({
            message: emailSent
                ? "Account created. Email accepted by Resend."
                : "Account created, but email sending failed.",
            emailSent,
            emailRedirected,
            ...(emailError ? { emailError } : {}),
            user: {
                id: result.insertId,
                name,
                email,
                role
            }
        });

    } catch (error) {
        console.error("CREATE ACCOUNT ERROR:", error);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                message: "Email already exists."
            });
        }

        return res.status(500).json({
            message: "Unable to create account."
        });
    }
};

// GET ACCOUNTS
exports.getAccounts = async (req, res) => {
    try {
        const [users] = await db.execute(
            `SELECT id, name, email, role
             FROM users
             WHERE role IN ('adviser', 'committee', 'super_admin')
             ORDER BY id DESC`
        );

        return res.json({ users });
    } catch (error) {
        console.error("GET ACCOUNTS ERROR:", error);

        return res.status(500).json({
            message: "Unable to load accounts."
        });
    }
};

// EDIT ACCOUNT
exports.updateAccount = async (req, res) => {
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
                message: "Valid name, email and role are required."
            });
        }

        if (!ALLOWED_ROLES.includes(role)) {
            return res.status(400).json({
                message: "Invalid role."
            });
        }

        // Super Admin accounts are protected from editing here.
        const [accounts] = await db.execute(
            `SELECT id FROM users
             WHERE id = ?
             AND role IN ('adviser', 'committee')
             LIMIT 1`,
            [id]
        );

        if (!accounts.length) {
            return res.status(404).json({
                message: "Account not found or protected."
            });
        }

        const [duplicate] = await db.execute(
            `SELECT id FROM users
             WHERE email = ? AND id <> ?
             LIMIT 1`,
            [email, id]
        );

        if (duplicate.length) {
            return res.status(409).json({
                message: "Email already used by another account."
            });
        }

        if (
            password !== undefined &&
            password !== null &&
            password !== ""
        ) {
            if (!validatePassword(password)) {
                return res.status(400).json({
                    message: "Temporary password must be at least 9 characters and at most 72 UTF-8 bytes."
                });
            }

            const hash = await bcrypt.hash(password, 12);

            await db.execute(
                `UPDATE users
                 SET name = ?,
                     email = ?,
                     role = ?,
                     password = ?,
                     must_change_password = 1
                 WHERE id = ?
                 AND role IN ('adviser', 'committee')`,
                [name, email, role, hash, id]
            );

        } else {
            await db.execute(
                `UPDATE users
                 SET name = ?,
                     email = ?,
                     role = ?
                 WHERE id = ?
                 AND role IN ('adviser', 'committee')`,
                [name, email, role, id]
            );
        }

        return res.json({
            message: "Account updated successfully.",
            user: {
                id: Number(id),
                name,
                email,
                role
            }
        });

    } catch (error) {
        console.error("UPDATE ACCOUNT ERROR:", error);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                message: "Email already used by another account."
            });
        }

        return res.status(500).json({
            message: "Unable to update account."
        });
    }
};

// DELETE ACCOUNT
exports.deleteAccount = async (req, res) => {
    try {
        const { id } = req.params;

        if (!validId(id)) {
            return res.status(400).json({
                message: "Invalid account ID."
            });
        }

        // Protect Super Admin accounts.
        const [result] = await db.execute(
            `DELETE FROM users
             WHERE id = ?
             AND role IN ('adviser', 'committee')`,
            [id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({
                message: "Account not found or protected."
            });
        }

        return res.json({
            message: "Account deleted successfully."
        });

    } catch (error) {
        console.error("DELETE ACCOUNT ERROR:", error);

        return res.status(500).json({
            message: "Unable to delete account."
        });
    }
};