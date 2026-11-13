
"use strict";

const db = require("../../../config/db");

function validId(value) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0;
}

function parseScopeIds(value) {
    if (!Array.isArray(value)) return null;

    const ids = value.map(Number);

    if (
        ids.length > 1000 ||
        ids.some(id => !validId(id)) ||
        new Set(ids).size !== ids.length
    ) {
        return null;
    }

    return ids;
}

// Kunin ang current o requested election
async function resolveElection(conn, electionId) {
    const current =
        electionId === undefined ||
        electionId === null ||
        electionId === "" ||
        electionId === "current";

    if (!current && !validId(electionId)) {
        return null;
    }

    const sql = current
        ? `SELECT election_id, title, school_level,
                  status, is_active, is_current, archived_at
           FROM elections
           WHERE is_current = 1
             AND archived_at IS NULL
           LIMIT 1`
        : `SELECT election_id, title, school_level,
                  status, is_active, is_current, archived_at
           FROM elections
           WHERE election_id = ?
           LIMIT 1`;

    const [rows] = await conn.execute(
        sql,
        current ? [] : [Number(electionId)]
    );

    return rows[0] || null;
}

// Puwede mag-assign habang hindi finalized ang scanning.
function canManageAssignments(election) {
    if (!election) return false;

    // Dapat current election lang.
    if (Number(election.is_current) !== 1) {
        return false;
    }

    // Hindi puwedeng archived election.
    if (election.archived_at) {
        return false;
    }

    // Hindi puwede kapag finalized na ang scanning.
    if (election.scanning_closed_at) {
        return false;
    }

    return true;
}

// Validate lahat ng selected scopes
async function validateScopes(conn, election, ids) {
    if (!canManageAssignments(election)) {
        const error = new Error(
            "Assignments can only be changed before the current election starts."
        );
        error.status = 409;
        throw error;
    }

    if (!ids.length) return;

    const placeholders = ids.map(() => "?").join(",");

    const [rows] = await conn.query(
        `SELECT scope_id
         FROM election_scopes
         WHERE election_id = ?
           AND is_active = 1
           AND scope_id IN (${placeholders})`,
        [election.election_id, ...ids]
    );

    if (rows.length !== ids.length) {
        const error = new Error(
            "One or more scopes are invalid, inactive, or belong to another election."
        );
        error.status = 400;
        throw error;
    }
}

// Save at revoke sa iisang transaction
async function saveAssignments(
    conn,
    committeeId,
    election,
    scopeIds,
    assignedBy
) {
    const ids = parseScopeIds(scopeIds);

    if (!ids) {
        const error = new Error(
            "scope_ids must be an array of unique positive IDs."
        );
        error.status = 400;
        throw error;
    }

    await validateScopes(conn, election, ids);

    const [users] = await conn.execute(
        `SELECT id, role
         FROM users
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [committeeId]
    );

    if (
        !users.length ||
        users[0].role !== "committee"
    ) {
        const error = new Error(
            "Account not found or account is not Committee."
        );
        error.status = 400;
        throw error;
    }

    // Kunin ang existing assignments ng election
    const [existing] = await conn.execute(
        `SELECT a.assignment_id, a.scope_id, a.is_active
         FROM committee_scope_assignments a
         JOIN election_scopes s
           ON s.scope_id = a.scope_id
         WHERE a.committee_user_id = ?
           AND s.election_id = ?
         FOR UPDATE`,
        [committeeId, election.election_id]
    );

    const selected = new Set(ids);

    // Revoke assignments na hindi na selected
    for (const row of existing) {
        if (!selected.has(Number(row.scope_id)) &&
            Number(row.is_active) === 1) {
            await conn.execute(
                `UPDATE committee_scope_assignments
                 SET is_active = 0,
                     revoked_at = CURRENT_TIMESTAMP
                 WHERE assignment_id = ?`,
                [row.assignment_id]
            );
        }
    }

    // Add o reactivate ang selected assignments
    for (const scopeId of ids) {
        await conn.execute(
            `INSERT INTO committee_scope_assignments
             (committee_user_id, scope_id, assigned_by,
              is_active, assigned_at, revoked_at)
             VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, NULL)
             ON DUPLICATE KEY UPDATE
                 is_active = 1,
                 assigned_by = ?,
                 revoked_at = NULL,
                 assigned_at = CASE
                     WHEN is_active = 0
                     THEN CURRENT_TIMESTAMP
                     ELSE assigned_at
                 END`,
            [
                committeeId,
                scopeId,
                assignedBy,
                assignedBy
            ]
        );
    }

    return ids;
}

function handleError(res, error) {
    console.error("ASSIGNMENT ERROR:", error);

    return res.status(error.status || 500).json({
        message: error.status
            ? error.message
            : "Unable to process Committee assignments."
    });
}

// GET available departments/grades
exports.getScopes = async (req, res) => {
    try {
        const election = await resolveElection(
            db,
            req.query.election_id
        );

        if (!election) {
            return res.status(404).json({
                message: "Election not found."
            });
        }

        const [scopes] = await db.execute(
            `SELECT scope_id, election_id, scope_type,
                    scope_code, scope_name, is_active
             FROM election_scopes
             WHERE election_id = ?
             ORDER BY scope_type, scope_name, scope_id`,
            [election.election_id]
        );

        return res.json({
            election: {
                election_id: election.election_id,
                title: election.title,
                school_level: election.school_level
            },
            can_manage: canManageAssignments(election),
            scopes
        });
    } catch (error) {
        return handleError(res, error);
    }
};

// GET assignments ng isang Committee
exports.getAssignments = async (req, res) => {
    try {
        const committeeId = Number(req.params.id);

        if (!validId(committeeId)) {
            return res.status(400).json({
                message: "Invalid Committee ID."
            });
        }

        const [users] = await db.execute(
            `SELECT id, name, role
             FROM users
             WHERE id = ?
             LIMIT 1`,
            [committeeId]
        );

        if (
            !users.length ||
            users[0].role !== "committee"
        ) {
            return res.status(404).json({
                message: "Committee account not found."
            });
        }

        const election = await resolveElection(
            db,
            req.query.election_id
        );

        if (!election) {
            return res.status(404).json({
                message: "Election not found."
            });
        }

        const [assignments] = await db.execute(
            `SELECT
                a.assignment_id,
                a.scope_id,
                a.is_active,
                a.assigned_at,
                a.revoked_at,
                s.election_id,
                s.scope_type,
                s.scope_code,
                s.scope_name
             FROM committee_scope_assignments a
             JOIN election_scopes s
               ON s.scope_id = a.scope_id
             WHERE a.committee_user_id = ?
               AND s.election_id = ?
             ORDER BY s.scope_type, s.scope_name`,
            [committeeId, election.election_id]
        );

        return res.json({
            committee: users[0],
            election_id: election.election_id,
            assignments
        });
    } catch (error) {
        return handleError(res, error);
    }
};

// PUT replace active assignments
exports.updateAssignments = async (req, res) => {
    let conn;

    try {
        const committeeId = Number(req.params.id);
        const scopeIds = parseScopeIds(req.body?.scope_ids);

        if (!validId(committeeId) || !scopeIds) {
            return res.status(400).json({
                message: "Invalid Committee ID or scope IDs."
            });
        }

        conn = await db.getConnection();
        await conn.beginTransaction();

        // Election lock para safe ang lifecycle changes
        const [rows] = await conn.execute(
            `SELECT election_id, title, school_level,
                    status, is_active, is_current, archived_at
             FROM elections
             WHERE is_current = 1
               AND archived_at IS NULL
             LIMIT 1
             FOR UPDATE`
        );

        const election = rows[0];

        if (!election) {
            const error = new Error(
                "No current election available."
            );
            error.status = 409;
            throw error;
        }

        if (
            req.body?.election_id != null &&
            Number(req.body.election_id) !==
                Number(election.election_id)
        ) {
            const error = new Error(
                "Selected election is not current."
            );
            error.status = 409;
            throw error;
        }

        await saveAssignments(
            conn,
            committeeId,
            election,
            scopeIds,
            req.user.id
        );

        await conn.commit();

        return res.json({
            success: true,
            message: "Committee assignments updated.",
            committee_user_id: committeeId,
            election_id: election.election_id,
            scope_ids: scopeIds
        });

    } catch (error) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (rollbackError) {
                console.error("ROLLBACK ERROR:", rollbackError);
            }
        }

        return handleError(res, error);

    } finally {
        if (conn) conn.release();
    }
};

// Reusable para sa Create/Edit Account integration
exports.saveAssignments = saveAssignments;
exports.parseScopeIds = parseScopeIds;
exports.canManageAssignments = canManageAssignments;
