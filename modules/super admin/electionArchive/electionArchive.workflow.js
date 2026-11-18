
"use strict";

const db = require("../../../config/db");
const jwt = require("jsonwebtoken");

// Use the same confirmed EmailJS path as your working controller.
const {
    sendElectionReportEmail
} = require("../../super admin/adduser/emailjs.server");

const validId = value =>
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0;

function apiError(message, status = 409) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function respondError(res, error) {
    console.error("ARCHIVE WORKFLOW:", error);

    return res.status(error.status || 500).json({
        message: error.status
            ? error.message
            : "Archive workflow failed. Check backend logs."
    });
}

async function getElection(conn, id, lock = false) {
    const [rows] = await conn.execute(
        `SELECT election_id, title, school_level,
                status, archived_at, voting_closed_at,
                scanning_open, scanning_closed_at
         FROM elections
         WHERE election_id = ?
         LIMIT 1
         ${lock ? "FOR UPDATE" : ""}`,
        [id]
    );

    return rows[0];
}

function checkReady(election) {
    if (!election) {
        throw apiError("Election not found.", 404);
    }

    if (election.archived_at) {
        throw apiError("Election already archived.");
    }

    if (
        election.status !== "completed" ||
        !election.voting_closed_at ||
        Number(election.scanning_open) !== 0 ||
        !election.scanning_closed_at
    ) {
        throw apiError(
            "Finish voting and scanning before proceeding."
        );
    }
}

async function checkPending(conn, electionId) {
    const [[row]] = await conn.execute(
        `SELECT COUNT(*) AS total
         FROM issued_ballots
         WHERE election_id = ?
           AND status = 'CAST'`,
        [electionId]
    );

    if (Number(row.total) > 0) {
        throw apiError(
            `${row.total} received ballots are not yet counted.`
        );
    }
}

async function getNotifications(conn, electionId) {
    const [rows] = await conn.execute(
        `SELECT adviser_user_id, status
         FROM election_report_notifications
         WHERE election_id = ?
         ORDER BY adviser_user_id`,
        [electionId]
    );

    return rows;
}

async function rollback(conn) {
    try {
        await conn.rollback();
    } catch (error) {
        console.error("ROLLBACK ERROR:", error);
    }
}


function getReportConfiguration() {
    const secret = process.env.REPORT_LINK_SECRET || "";

    const base = (
        process.env.REPORT_PUBLIC_API_BASE || ""
    ).trim();

    console.log("REPORT CONFIG CHECK:", {
        secretExists: Boolean(secret),
        secretLength: Buffer.byteLength(secret, "utf8"),
        apiBaseExists: Boolean(base),
        httpsValid: base.startsWith("https://")
    });

    if (!secret) {
        throw apiError(
            "REPORT_LINK_SECRET is missing.",
            503
        );
    }

    if (Buffer.byteLength(secret, "utf8") < 32) {
        throw apiError(
            "REPORT_LINK_SECRET must be at least 32 bytes.",
            503
        );
    }

    if (!base) {
        throw apiError(
            "REPORT_PUBLIC_API_BASE is missing.",
            503
        );
    }

    if (!base.startsWith("https://")) {
        throw apiError(
            "REPORT_PUBLIC_API_BASE must start with https://.",
            503
        );
    }

    return {
        secret,
        base: base.replace(/\/+$/, "")
    };
}


// SEND EMAIL REPORT LINKS
exports.notify = async (req, res) => {
    const electionId = Number(req.params.id);
    const input = req.body?.adviser_ids;

    if (
        !validId(electionId) ||
        !Array.isArray(input) ||
        input.length < 1 ||
        input.length > 20 ||
        input.some(id => !validId(id))
    ) {
        return res.status(400).json({
            message: "Select 1 to 20 valid Advisers."
        });
    }

    const adviserIds = input
        .map(Number)
        .sort((a, b) => a - b);

    if (new Set(adviserIds).size !== adviserIds.length) {
        return res.status(400).json({
            message: "Duplicate Adviser IDs are not allowed."
        });
    }

    let conn;

    try {
        const { secret, base } = getReportConfiguration();

        conn = await db.getConnection();
        await conn.beginTransaction();

        const election = await getElection(
            conn,
            electionId,
            true
        );

        checkReady(election);
        await checkPending(conn, electionId);

        const existing = await getNotifications(
            conn,
            electionId
        );

        if (!existing.length) {
            const placeholders = adviserIds
                .map(() => "?")
                .join(",");

            const [users] = await conn.query(
                `SELECT DISTINCT u.id, u.name, u.email
                 FROM election_adviser_assignments a
                 JOIN users u
                   ON u.id = a.adviser_user_id
                 WHERE a.election_id = ?
                   AND a.is_active = 1
                   AND u.role = 'adviser'
                   AND u.id IN (${placeholders})`,
                [electionId, ...adviserIds]
            );

            if (users.length !== adviserIds.length) {
                throw apiError(
                    "Selected Advisers must have active assignments.",
                    400
                );
            }

            for (const user of users) {
                await conn.execute(
                    `INSERT INTO election_report_notifications
                     (election_id, adviser_user_id, status)
                     VALUES (?, ?, 'PENDING')`,
                    [electionId, user.id]
                );
            }
        } else {
            const savedIds = existing.map(row =>
                Number(row.adviser_user_id)
            );

            const sameRecipients =
                savedIds.length === adviserIds.length &&
                savedIds.every(
                    (id, index) => id === adviserIds[index]
                );

            if (!sameRecipients) {
                throw apiError(
                    "Recipients are already locked for this election. " +
                    "Manual review is required to change them."
                );
            }
        }

        await conn.commit();
        conn.release();
        conn = null;

        for (const adviserId of adviserIds) {
            // Claim only an unsent notification.
            const [claimed] = await db.execute(
                `UPDATE election_report_notifications
                 SET status = 'SENDING',
                     attempted_at = CURRENT_TIMESTAMP
                 WHERE election_id = ?
                   AND adviser_user_id = ?
                   AND status = 'PENDING'`,
                [electionId, adviserId]
            );

            if (!claimed.affectedRows) {
                continue;
            }

            try {
                const [users] = await db.execute(
                    `SELECT u.id, u.name, u.email
                     FROM users u
                     JOIN election_adviser_assignments a
                       ON a.adviser_user_id = u.id
                     WHERE a.election_id = ?
                       AND a.is_active = 1
                       AND u.role = 'adviser'
                       AND u.id = ?
                     LIMIT 1`,
                    [electionId, adviserId]
                );

                if (!users.length) {
                    throw new Error(
                        "Adviser assignment is no longer active."
                    );
                }

                const adviser = users[0];

                const signedToken = jwt.sign(
                    {
                        election_id: electionId,
                        adviser_id: adviser.id,
                        purpose: "election_pdf"
                    },
                    secret,
                    {
                        algorithm: "HS256",
                        expiresIn: "7d",
                        issuer: "campusvote",
                        audience: "election-report"
                    }
                );

                const reportUrl =
                    `${base}/election_archive/report-download` +
                    `?token=${encodeURIComponent(signedToken)}`;

                const sent = await sendElectionReportEmail({
                    to: adviser.email,
                    adviserName: adviser.name,
                    electionTitle: election.title,
                    schoolLevel: election.school_level,
                    reportUrl
                });

                if (sent?.sent !== true) {
                    throw new Error(
                        "EmailJS did not confirm acceptance."
                    );
                }

                await db.execute(
                    `UPDATE election_report_notifications
                     SET status = 'ACCEPTED',
                         accepted_at = CURRENT_TIMESTAMP
                     WHERE election_id = ?
                       AND adviser_user_id = ?
                       AND status = 'SENDING'`,
                    [electionId, adviserId]
                );
            } catch (error) {
                console.error(
                    "EMAIL STATUS UNCERTAIN:",
                    adviserId,
                    error.message
                );

                try {
                    await db.execute(
                        `UPDATE election_report_notifications
                         SET status = 'UNKNOWN'
                         WHERE election_id = ?
                           AND adviser_user_id = ?
                           AND status = 'SENDING'`,
                        [electionId, adviserId]
                    );
                } catch (recordError) {
                    console.error(
                        "EMAIL STATUS SAVE ERROR:",
                        recordError
                    );
                }
            }
        }

        const results = await getNotifications(
            db,
            electionId
        );

        const acceptedCount = results.filter(
            row => row.status === "ACCEPTED"
        ).length;

        return res.status(
            acceptedCount === results.length ? 200 : 207
        ).json({
            message:
                `${acceptedCount}/${results.length} email requests accepted.` +
                (acceptedCount === results.length
                    ? " Election is ready for final archiving."
                    : " Uncertain requests need manual review."),
            accepted_count: acceptedCount,
            total: results.length,
            results: results.map(row => ({
                adviser_id: row.adviser_user_id,
                status: row.status
            })),
            archived: false
        });
    } catch (error) {
        if (conn) {
            await rollback(conn);
        }

        return respondError(res, error);
    } finally {
        if (conn) {
            conn.release();
        }
    }
};

// CHECK REPORT NOTIFICATION STATUS
exports.status = async (req, res) => {
    const electionId = Number(req.params.id);

    if (!validId(electionId)) {
        return res.status(400).json({
            message: "Invalid election ID."
        });
    }

    try {
        const rows = await getNotifications(
            db,
            electionId
        );

        return res.json({
            recipients: rows,
            ready_to_archive:
                rows.length > 0 &&
                rows.every(row => row.status === "ACCEPTED")
        });
    } catch (error) {
        return respondError(res, error);
    }
};

// FINAL ARCHIVE
exports.archive = async (req, res) => {
    const electionId = Number(req.params.id);

    if (!validId(electionId)) {
        return res.status(400).json({
            message: "Invalid election ID."
        });
    }

    let conn;
    let locked = false;
    let transaction = false;

    try {
        conn = await db.getConnection();

        const [[lock]] = await conn.query(
            "SELECT GET_LOCK('campusvote_election_cycle', 10) AS acquired"
        );

        if (lock.acquired !== 1) {
            throw apiError(
                "Election management is busy. Please retry.",
                503
            );
        }

        locked = true;

        await conn.beginTransaction();
        transaction = true;

        const election = await getElection(
            conn,
            electionId,
            true
        );

        checkReady(election);
        await checkPending(conn, electionId);

        const notifications = await getNotifications(
            conn,
            electionId
        );

        if (
            !notifications.length ||
            notifications.some(
                row => row.status !== "ACCEPTED"
            )
        ) {
            throw apiError(
                "Cannot archive. All selected Adviser email " +
                "requests must be accepted first."
            );
        }

        // Ensure selected Adviser assignments remain valid.
        const [activeAdvisers] = await conn.execute(
            `SELECT DISTINCT a.adviser_user_id
             FROM election_adviser_assignments a
             JOIN users u
               ON u.id = a.adviser_user_id
             WHERE a.election_id = ?
               AND a.is_active = 1
               AND u.role = 'adviser'`,
            [electionId]
        );

        const activeIds = new Set(
            activeAdvisers.map(
                row => Number(row.adviser_user_id)
            )
        );

        if (notifications.some(
            row => !activeIds.has(Number(row.adviser_user_id))
        )) {
            throw apiError(
                "An Adviser assignment has changed. " +
                "Manual review is required."
            );
        }

        // Deactivate Adviser assignments.
        const [advisers] = await conn.execute(
            `UPDATE election_adviser_assignments
             SET is_active = 0,
                 revoked_at = CURRENT_TIMESTAMP
             WHERE election_id = ?
               AND is_active = 1`,
            [electionId]
        );

        // Deactivate Committee assignments by election scope.
        const [committees] = await conn.execute(
            `UPDATE committee_scope_assignments a
             JOIN election_scopes s
               ON s.scope_id = a.scope_id
             SET a.is_active = 0,
                 a.revoked_at = CURRENT_TIMESTAMP
             WHERE s.election_id = ?
               AND a.is_active = 1`,
            [electionId]
        );

        // Preserve the existing archive fields.
        await conn.execute(
            `UPDATE elections
             SET archived_at = (UTC_TIMESTAMP() + INTERVAL 8 HOUR),
                 is_current = 0,
                 is_active = 0
             WHERE election_id = ?`,
            [electionId]
        );

        await conn.commit();
        transaction = false;

        return res.json({
            archived: true,
            election_id: electionId,
            adviser_assignments_deactivated:
                advisers.affectedRows,
            committee_assignments_deactivated:
                committees.affectedRows,
            message:
                "Election archived successfully. " +
                "Assignment history preserved."
        });
    } catch (error) {
        if (conn && transaction) {
            await rollback(conn);
        }

        return respondError(res, error);
    } finally {
        if (conn) {
            if (locked) {
                try {
                    await conn.query(
                        "SELECT RELEASE_LOCK('campusvote_election_cycle')"
                    );
                } catch (error) {
                    console.error(
                        "LOCK RELEASE ERROR:",
                        error
                    );
                }
            }

            conn.release();
        }
    }
};
