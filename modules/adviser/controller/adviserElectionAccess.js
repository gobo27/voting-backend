
"use strict";

const db = require("../../../config/db");

module.exports = async function adviserElectionAccess(
    req,
    res,
    next
) {
    try {
        const user = req.user;

        if (!user) {
            return res.status(401).json({
                message: "Authentication required."
            });
        }

        // Adviser assignment validation only.
        // Other roles continue to use existing role rules.
        if (user.role !== "adviser") {
            return next();
        }

        const adviserId = Number(user.id);
        const requestedId = req.params.election_id;

        if (
            !Number.isSafeInteger(adviserId) ||
            adviserId <= 0
        ) {
            return res.status(403).json({
                message: "Invalid Adviser account."
            });
        }

        const isCurrent = requestedId === "current";

        if (
            !isCurrent &&
            (
                !Number.isSafeInteger(Number(requestedId)) ||
                Number(requestedId) <= 0
            )
        ) {
            return res.status(400).json({
                message: "Invalid election ID."
            });
        }

        const [rows] = await db.execute(
            `SELECT e.election_id
             FROM election_adviser_assignments a
             JOIN elections e
               ON e.election_id = a.election_id
             WHERE a.adviser_user_id = ?
               AND a.is_active = 1
               AND e.is_current = 1
               AND e.archived_at IS NULL
               AND (
                   ? = 'current'
                   OR e.election_id = ?
               )
             LIMIT 1`,
            [
                adviserId,
                String(requestedId),
                isCurrent ? 0 : Number(requestedId)
            ]
        );

        if (!rows.length) {
            return res.status(403).json({
                message:
                    "Access denied. You are not assigned " +
                    "to this election."
            });
        }

        return next();

    } catch (error) {
        console.error(
            "ADVISER ELECTION ACCESS ERROR:",
            error
        );

        return res.status(500).json({
            message:
                "Unable to verify Adviser election assignment."
        });
    }
};
