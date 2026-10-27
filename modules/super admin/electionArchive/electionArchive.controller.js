"use strict";

const db = require("../../../config/db");

const PH_NOW_SQL = "(UTC_TIMESTAMP() + INTERVAL 8 HOUR)";

function validId(value) {
    return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function fail(res, error) {
    console.error("Election archive:", error);
    return res.status(500).json({
        message: "Database operation failed"
    });
}

// ======================================
// SAFE TRANSACTION
// ======================================

async function lockedTransaction(callback) {
    const conn = await db.getConnection();
    let locked = false;
    let started = false;

    try {
        const [[result]] = await conn.query(
            "SELECT GET_LOCK('campusvote_election_cycle', 10) AS acquired"
        );

        if (result.acquired !== 1) {
            throw new Error("Election management is busy. Please retry.");
        }

        locked = true;

        await conn.beginTransaction();
        started = true;

        const output = await callback(conn);

        if (output && output.code >= 400) {
            await conn.rollback();
        } else {
            await conn.commit();
        }

        started = false;
        return output;

    } catch (error) {
        if (started) {
            try {
                await conn.rollback();
            } catch (e) {
                console.error("Rollback failed:", e);
            }
        }
        throw error;

    } finally {
        if (locked) {
            try {
                await conn.query(
                    "SELECT RELEASE_LOCK('campusvote_election_cycle')"
                );
            } catch (e) {
                console.error("Release lock failed:", e);
            }
        }
        conn.release();
    }
}

// ======================================
// GET ELECTION HISTORY
// ======================================

exports.list = async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT
                e.election_id,
                e.title,
                e.start_time,
                e.end_time,
                e.status,
                e.is_active,
                e.is_current,
                e.archived_at,
                e.scanning_open,
                e.scanning_closed_at,

                (
                    SELECT COUNT(*)
                    FROM positions p
                    WHERE p.election_id = e.election_id
                ) AS positions_count,

                (
                    SELECT COUNT(*)
                    FROM candidates c
                    WHERE c.election_id = e.election_id
                ) AS candidates_count,

                (
                    SELECT COUNT(*)
                    FROM scanned_ballots s
                    WHERE s.election_id = e.election_id
                ) AS scanned_ballots_count

            FROM elections e
            ORDER BY e.election_id DESC
        `);

        return res.json({ elections: rows });

    } catch (error) {
        return fail(res, error);
    }
};

// ======================================
// VIEW ELECTION DETAILS
// READ ONLY
// ======================================

exports.details = async (req, res) => {
    const electionId = Number(req.params.id);

    if (!validId(electionId)) {
        return res.status(400).json({
            message: "Invalid election ID"
        });
    }

    try {
        const [elections] = await db.execute(
            `SELECT
                election_id,
                title,
                start_time,
                end_time,
                status,
                is_current,
                archived_at,
                voting_closed_at,
                scanning_closed_at
             FROM elections
             WHERE election_id = ?
             LIMIT 1`,
            [electionId]
        );

        if (!elections.length) {
            return res.status(404).json({
                message: "Election not found"
            });
        }

        const [positions] = await db.execute(
            `SELECT
                position_id,
                title,
                max_selection,
                display_order
             FROM positions
             WHERE election_id = ?
             ORDER BY display_order, position_id`,
            [electionId]
        );

        const [candidates] = await db.execute(
            `SELECT
                candidate_id,
                position_id,
                name,
                course,
                grade_level,
                party_list
             FROM candidates
             WHERE election_id = ?
             ORDER BY position_id, display_order, candidate_id`,
            [electionId]
        );

        const [templates] = await db.execute(
            `SELECT
                template_id,
                template_name,
                paper_size
             FROM ballot_templates
             WHERE election_id = ?
             ORDER BY template_id`,
            [electionId]
        );

        const [ballots] = await db.execute(
            `SELECT status, COUNT(*) AS total
             FROM issued_ballots
             WHERE election_id = ?
             GROUP BY status`,
            [electionId]
        );

        const [votes] = await db.execute(
            `SELECT
                v.position_id,
                v.candidate_id,
                COUNT(*) AS total_votes
             FROM ballot_votes v
             JOIN issued_ballots b
                ON b.ballot_id = v.ballot_id
             WHERE b.election_id = ?
               AND b.status = 'COUNTED'
             GROUP BY v.position_id, v.candidate_id`,
            [electionId]
        );

        const [scans] = await db.execute(
            `SELECT COUNT(*) AS total
             FROM scanned_ballots
             WHERE election_id = ?`,
            [electionId]
        );

        return res.json({
            election: elections[0],
            positions,
            candidates,
            templates,
            ballot_status_counts: ballots,
            recorded_votes: votes,
            scanned_ballots_count: Number(scans[0].total),
            note: "Read-only historical data from saved database records."
        });

    } catch (error) {
        return fail(res, error);
    }
};

// ======================================
// ARCHIVE ELECTION
// ======================================

exports.archive = async (req, res) => {
    const electionId = Number(req.params.id);

    if (!validId(electionId)) {
        return res.status(400).json({
            message: "Invalid election ID"
        });
    }

    try {
        const result = await lockedTransaction(async conn => {
            const [rows] = await conn.execute(
                `SELECT
                    election_id,
                    status,
                    is_current,
                    archived_at,
                    voting_closed_at,
                    scanning_open,
                    scanning_closed_at
                 FROM elections
                 WHERE election_id = ?
                 FOR UPDATE`,
                [electionId]
            );

            if (!rows.length) {
                return {
                    code: 404,
                    message: "Election not found"
                };
            }

            const election = rows[0];

            if (election.archived_at) {
                return {
                    code: 409,
                    message: "Election already archived"
                };
            }

            if (election.status !== "completed") {
                return {
                    code: 409,
                    message: "Stop voting before archiving this election"
                };
            }

            if (!election.voting_closed_at) {
                return {
                    code: 409,
                    message: "Voting must be closed before archiving."
                };
            }

            if (Number(election.scanning_open) !== 0) {
                return {
                    code: 409,
                    message: "Finish scanning before archiving."
                };
            }

            if (!election.scanning_closed_at) {
                return {
                    code: 409,
                    message: "Finish Scanning has not been completed yet."
                };
            }

            const [pending] = await conn.execute(
                `SELECT COUNT(*) AS total
                 FROM issued_ballots
                 WHERE election_id = ?
                   AND status = 'CAST'`,
                [electionId]
            );

            const pendingCount = Number(pending[0].total);

            if (pendingCount > 0) {
                return {
                    code: 409,
                    message:
                        `${pendingCount} received ballot(s) are not yet counted.`
                };
            }

            await conn.execute(
                `UPDATE elections
                 SET archived_at = ${PH_NOW_SQL},
                     is_current = 0,
                     is_active = 0
                 WHERE election_id = ?`,
                [electionId]
            );

            return {
                code: 200,
                message: "Election archived. Historical data preserved.",
                election_id: electionId,
                archived: true
            };
        });

        return res.status(result.code).json(result);

    } catch (error) {
        return fail(res, error);
    }
};

// ======================================
// CREATE NEW ELECTION
// ======================================

exports.create = async (req, res) => {
    const title = String(req.body?.title || "").trim();
    const start = String(req.body?.start_time || "");
    const end = String(req.body?.end_time || "");

    const copyId = req.body?.copy_positions_from
        ? Number(req.body.copy_positions_from)
        : null;

    if (!title || title.length > 150) {
        return res.status(400).json({
            message: "Title is required (max 150 characters)"
        });
    }

    const dateFormat =
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

    if (
        !dateFormat.test(start) ||
        !dateFormat.test(end) ||
        start >= end
    ) {
        return res.status(400).json({
            message: "Invalid start or end date"
        });
    }

    if (copyId !== null && !validId(copyId)) {
        return res.status(400).json({
            message: "Invalid source election ID"
        });
    }

    try {
        const result = await lockedTransaction(async conn => {
            const [current] = await conn.query(
                `SELECT election_id
                 FROM elections
                 WHERE is_current = 1
                 LIMIT 1
                 FOR UPDATE`
            );

            if (current.length) {
                return {
                    code: 409,
                    message:
                        "Archive the current election before creating a new one."
                };
            }

            if (copyId !== null) {
                const [source] = await conn.execute(
                    `SELECT election_id
                     FROM elections
                     WHERE election_id = ?`,
                    [copyId]
                );

                if (!source.length) {
                    return {
                        code: 404,
                        message: "Source election not found"
                    };
                }
            }

            const [insert] = await conn.execute(
                `INSERT INTO elections
                (
                    title,
                    start_time,
                    end_time,
                    status,
                    is_active,
                    mask_names,
                    is_current
                )
                VALUES (?, ?, ?, NULL, 0, 0, 1)`,
                [title, start, end]
            );

            if (copyId !== null) {
                await conn.execute(
                    `INSERT INTO positions
                    (
                        election_id,
                        title,
                        max_selection,
                        display_order
                    )
                    SELECT
                        ?,
                        title,
                        max_selection,
                        display_order
                    FROM positions
                    WHERE election_id = ?`,
                    [insert.insertId, copyId]
                );
            }

            return {
                code: 201,
                message: "New election created",
                election_id: insert.insertId
            };
        });

        return res.status(result.code).json(result);

    } catch (error) {
        return fail(res, error);
    }
};