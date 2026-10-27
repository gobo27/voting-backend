
"use strict";

const pool = require("../../../config/db");

function validId(value) {
    return Number.isSafeInteger(Number(value)) &&
        Number(value) > 0;
}

exports.receiveBallot = async (req, res) => {
    const electionId = Number(req.body?.election_id);
    const ballotId = String(req.body?.ballot_id || "")
        .trim()
        .toLowerCase();

    if (
        !validId(electionId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ballotId)
    ) {
        return res.status(400).json({
            message: "Valid election ID and Ballot ID required."
        });
    }

    let db;
    let transactionStarted = false;

    try {
        db = await pool.getConnection();
        await db.beginTransaction();
        transactionStarted = true;

        // Lock election first, consistent with scanner.
        const [elections] = await db.execute(
            `SELECT
                election_id,
                status,
                is_current,
                archived_at,
                start_time,
                end_time,
                voting_closed_at
             FROM elections
             WHERE election_id = ?
             FOR UPDATE`,
            [electionId]
        );

        const election = elections[0];

        if (
            !election ||
            Number(election.is_current) !== 1 ||
            election.archived_at
        ) {
            await db.rollback();
            transactionStarted = false;

            return res.status(409).json({
                message: "Current election is not available."
            });
        }

        const [timeRows] = await db.query(
            `SELECT
                (UTC_TIMESTAMP() + INTERVAL 8 HOUR) AS ph_now`
        );

        const now = new Date(timeRows[0].ph_now);
        const start = new Date(election.start_time);
        const end = new Date(election.end_time);

        if (
            election.status !== "active" ||
            election.voting_closed_at ||
            !Number.isFinite(start.getTime()) ||
            !Number.isFinite(end.getTime()) ||
            now < start ||
            now >= end
        ) {
            await db.rollback();
            transactionStarted = false;

            return res.status(409).json({
                message:
                    "Voting is closed. New ballots cannot be received."
            });
        }

        const [ballots] = await db.execute(
            `SELECT ballot_id, status
             FROM issued_ballots
             WHERE ballot_id = ?
               AND election_id = ?
             FOR UPDATE`,
            [ballotId, electionId]
        );

        if (!ballots.length) {
            await db.rollback();
            transactionStarted = false;

            return res.status(404).json({
                message: "Unregistered ballot."
            });
        }

        if (ballots[0].status !== "ISSUED") {
            await db.rollback();
            transactionStarted = false;

            return res.status(409).json({
                message:
                    `Ballot already has status ${ballots[0].status}.`
            });
        }

        await db.execute(
            `UPDATE issued_ballots
             SET status = 'CAST',
                 cast_at = UTC_TIMESTAMP() + INTERVAL 8 HOUR
             WHERE ballot_id = ?
               AND status = 'ISSUED'`,
            [ballotId]
        );

        await db.commit();
        transactionStarted = false;

        return res.status(200).json({
            message: "Ballot received successfully.",
            ballot_id: ballotId,
            status: "CAST"
        });

    } catch (error) {
        if (transactionStarted && db) {
            try {
                await db.rollback();
            } catch (_) {}
        }

        console.error("Receive ballot error:", error);

        return res.status(500).json({
            message: "Failed to receive ballot."
        });

    } finally {
        if (db) db.release();
    }
};
