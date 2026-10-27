
const connection = require("../../../config/db");

// ================= HELPERS =================

function cleanTitle(value) {
    return typeof value === "string"
        ? value.trim().replace(/\s+/g, " ")
        : "";
}

function validId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0;
}

function handleError(res, label, error) {
    console.error(label, error);

    return res.status(500).json({
        message: "Internal server error"
    });
}

// Resolve the current election or a specific election.
// Specific IDs are allowed for reading election history.
async function resolveElection(value) {
    if (value === "current") {
        const [rows] = await connection.execute(
            `SELECT election_id, title, status,
                    is_active, is_current, archived_at
             FROM elections
             WHERE is_current = 1
               AND archived_at IS NULL
             LIMIT 1`
        );

        return rows[0] || null;
    }

    if (!validId(value)) {
        return null;
    }

    const [rows] = await connection.execute(
        `SELECT election_id, title, status,
                is_active, is_current, archived_at
         FROM elections
         WHERE election_id = ?
         LIMIT 1`,
        [Number(value)]
    );

    return rows[0] || null;
}

// Current election must not be completed or archived.

function canEdit(election) {
    if (!election) return false;

    const status = String(election.status || "")
        .trim()
        .toLowerCase();

    return (
        Number(election.is_current) === 1 &&
        Number(election.is_active) === 0 &&
        election.archived_at == null &&
        status !== "active" &&
        status !== "completed"
    );
}
async function withCurrentElection(callback) {
    const db = await connection.getConnection();

    try {
        await db.beginTransaction();

        const [rows] = await db.execute(
            `SELECT election_id, status, is_active, is_current, archived_at
             FROM elections
             WHERE is_current = 1
               AND archived_at IS NULL
             LIMIT 1
             FOR UPDATE`
        );

        const election = rows[0] || null;

        if (!election) {
            await db.rollback();

            return {
                status: 409,
                body: {
                    message: "No current election available"
                }
            };
        }

        if (!canEdit(election)) {
            await db.rollback();

            return {
                status: 409,
                body: {
                    message:
                        "Cannot modify positions in a completed or archived election"
                }
            };
        }

        const result = await callback(db, election);

        if (result.status >= 400) {
            await db.rollback();
        } else {
            await db.commit();
        }

        return result;

    } catch (error) {
        try {
            await db.rollback();
        } catch (_) {}

        throw error;

    } finally {
        db.release();
    }
}

// ================= ADD OR REUSE POSITION =================

exports.addPosition = async (req, res) => {
    const {
        election_id,
        max_selection = 1,
        display_order = 1
    } = req.body || {};

    const title = cleanTitle(req.body?.title);

    if (!title || title.length > 100) {
        return res.status(400).json({
            message: "Valid position title is required"
        });
    }

    if (
        !validId(max_selection) ||
        !validId(display_order)
    ) {
        return res.status(400).json({
            message: "Invalid selection or display order"
        });
    }

    if (
        election_id !== undefined &&
        election_id !== null &&
        election_id !== "current" &&
        !validId(election_id)
    ) {
        return res.status(400).json({
            message: "Invalid election ID"
        });
    }

    try {
        const result = await withCurrentElection(
            async (db, election) => {

                if (
                    election_id !== undefined &&
                    election_id !== null &&
                    election_id !== "current" &&
                    Number(election_id) !== election.election_id
                ) {
                    return {
                        status: 409,
                        body: {
                            message:
                                "The selected election is no longer current. Refresh the page."
                        }
                    };
                }

                const [existing] = await db.execute(
                    `SELECT position_id, election_id, title,
                            max_selection, display_order
                     FROM positions
                     WHERE election_id = ?
                       AND LOWER(TRIM(title)) = LOWER(?)
                     LIMIT 1`,
                    [election.election_id, title]
                );

                if (existing.length) {
                    return {
                        status: 200,
                        body: {
                            message: "Existing position reused",
                            position: existing[0]
                        }
                    };
                }

                const [insert] = await db.execute(
                    `INSERT INTO positions
                     (
                         election_id,
                         title,
                         max_selection,
                         display_order
                     )
                     VALUES (?, ?, ?, ?)`,
                    [
                        election.election_id,
                        title,
                        Number(max_selection),
                        Number(display_order)
                    ]
                );

                return {
                    status: 201,
                    body: {
                        message: "Position added successfully",
                        position: {
                            position_id: insert.insertId,
                            election_id: election.election_id,
                            title,
                            max_selection: Number(max_selection),
                            display_order: Number(display_order)
                        }
                    }
                };
            }
        );

        return res.status(result.status).json(result.body);

    } catch (error) {
        return handleError(res, "Add position error:", error);
    }
};

// ================= GET POSITIONS WITH CANDIDATES =================

exports.getPositions = async (req, res) => {
    try {
        const election = await resolveElection(
            req.params.election_id
        );

        if (!election) {
            return res.status(404).json({
                message: "Election not found"
            });
        }

        const election_id = election.election_id;

        const [positions] = await connection.execute(
            `SELECT position_id, election_id, title,
                    max_selection, display_order
             FROM positions
             WHERE election_id = ?
             ORDER BY display_order, position_id`,
            [election_id]
        );

        const [candidates] = await connection.execute(
            `SELECT c.candidate_id, c.name, c.course,
                    c.grade_level, c.party_list,
                    c.position_id, c.display_order
             FROM candidates c
             INNER JOIN positions p
                ON p.position_id = c.position_id
               AND p.election_id = c.election_id
             WHERE p.election_id = ?
               AND c.election_id = ?
             ORDER BY
                c.position_id,
                c.display_order,
                c.candidate_id`,
            [election_id, election_id]
        );

        const result = positions.map(position => ({
            ...position,
            candidates: candidates.filter(
                candidate =>
                    candidate.position_id === position.position_id
            )
        }));

        return res.status(200).json({
            election_id,
            positions: result
        });

    } catch (error) {
        return handleError(res, "Get positions error:", error);
    }
};

// ================= UPDATE POSITION =================

exports.updatePosition = async (req, res) => {
    const { position_id } = req.params;

    const {
        max_selection,
        display_order
    } = req.body || {};

    const title = req.body?.title === undefined
        ? undefined
        : cleanTitle(req.body.title);

    if (!validId(position_id)) {
        return res.status(400).json({
            message: "Invalid position ID"
        });
    }

    if (
        (title !== undefined && (!title || title.length > 100)) ||
        (max_selection !== undefined && !validId(max_selection)) ||
        (display_order !== undefined && !validId(display_order))
    ) {
        return res.status(400).json({
            message: "Invalid position fields"
        });
    }

    try {
        const result = await withCurrentElection(
            async (db, election) => {

                const [existing] = await db.execute(
                    `SELECT *
                     FROM positions
                     WHERE position_id = ?
                     FOR UPDATE`,
                    [Number(position_id)]
                );

                if (!existing.length) {
                    return {
                        status: 404,
                        body: {
                            message: "Position not found"
                        }
                    };
                }

                const old = existing[0];

                if (old.election_id !== election.election_id) {
                    return {
                        status: 403,
                        body: {
                            message:
                                "Cannot edit a position from another election"
                        }
                    };
                }

                const updated = {
                    title: title ?? old.title,
                    max_selection:
                        max_selection === undefined
                            ? old.max_selection
                            : Number(max_selection),
                    display_order:
                        display_order === undefined
                            ? old.display_order
                            : Number(display_order)
                };

                const [duplicates] = await db.execute(
                    `SELECT position_id
                     FROM positions
                     WHERE election_id = ?
                       AND LOWER(TRIM(title)) = LOWER(?)
                       AND position_id <> ?
                     LIMIT 1`,
                    [
                        election.election_id,
                        updated.title,
                        Number(position_id)
                    ]
                );

                if (duplicates.length) {
                    return {
                        status: 409,
                        body: {
                            message: "Position already exists"
                        }
                    };
                }

                await db.execute(
                    `UPDATE positions
                     SET title = ?,
                         max_selection = ?,
                         display_order = ?
                     WHERE position_id = ?
                       AND election_id = ?`,
                    [
                        updated.title,
                        updated.max_selection,
                        updated.display_order,
                        Number(position_id),
                        election.election_id
                    ]
                );

                return {
                    status: 200,
                    body: {
                        message: "Position updated successfully",
                        position: {
                            position_id: Number(position_id),
                            election_id: election.election_id,
                            ...updated
                        }
                    }
                };
            }
        );

        return res.status(result.status).json(result.body);

    } catch (error) {
        return handleError(res, "Update position error:", error);
    }
};

// ================= DELETE POSITION =================

exports.deletePosition = async (req, res) => {
    const { position_id } = req.params;

    if (!validId(position_id)) {
        return res.status(400).json({
            message: "Invalid position ID"
        });
    }

    try {
        const result = await withCurrentElection(
            async (db, election) => {

                const [positions] = await db.execute(
                    `SELECT position_id, election_id
                     FROM positions
                     WHERE position_id = ?
                     FOR UPDATE`,
                    [Number(position_id)]
                );

                if (!positions.length) {
                    return {
                        status: 404,
                        body: {
                            message: "Position not found"
                        }
                    };
                }

                if (
                    positions[0].election_id !== election.election_id
                ) {
                    return {
                        status: 403,
                        body: {
                            message:
                                "Cannot delete a position from another election"
                        }
                    };
                }

                const [candidates] = await db.execute(
                    `SELECT candidate_id
                     FROM candidates
                     WHERE position_id = ?
                       AND election_id = ?
                     LIMIT 1`,
                    [
                        Number(position_id),
                        election.election_id
                    ]
                );

                if (candidates.length) {
                    return {
                        status: 409,
                        body: {
                            message:
                                "Cannot delete a position that has candidates."
                        }
                    };
                }

                const [deleted] = await db.execute(
                    `DELETE FROM positions
                     WHERE position_id = ?
                       AND election_id = ?`,
                    [
                        Number(position_id),
                        election.election_id
                    ]
                );

                return {
                    status: deleted.affectedRows ? 200 : 404,
                    body: {
                        message: deleted.affectedRows
                            ? "Position deleted successfully"
                            : "Position not found"
                    }
                };
            }
        );

        return res.status(result.status).json(result.body);

    } catch (error) {
        return handleError(res, "Delete position error:", error);
    }
};
