
"use strict";

const crypto = require("crypto");
const QRCode = require("qrcode");
const pool = require("../../../config/db");

function validId(value) {
    return Number.isSafeInteger(Number(value)) &&
        Number(value) > 0;
}

function qrPayload(ballot) {
    return [
        "CV1",
        ballot.election_id,
        ballot.ballot_id,
        ballot.template_id
    ].join("|");
}

// Same request_id, same registered QR batch.
async function existingBatchResponse(
    db,
    requestId,
    electionId,
    templateId,
    quantity
) {
    const [batches] = await db.execute(
        `SELECT batch_id, election_id, template_id, quantity
         FROM ballot_print_batches
         WHERE request_id = ?
         LIMIT 1`,
        [requestId]
    );

    if (!batches.length) return null;

    const batch = batches[0];

    if (
        Number(batch.election_id) !== electionId ||
        Number(batch.template_id) !== templateId ||
        Number(batch.quantity) !== quantity
    ) {
        return { conflict: true };
    }

    const [rows] = await db.execute(
        `SELECT ballot_id, election_id, template_id
         FROM issued_ballots
         WHERE batch_id = ?
         ORDER BY created_at, ballot_id`,
        [batch.batch_id]
    );

    if (rows.length !== quantity) {
        throw new Error(
            "Registered batch has an unexpected ballot count."
        );
    }

    const ballots = await Promise.all(
        rows.map(async ballot => ({
            ballot_id: ballot.ballot_id,
            qr_code: await QRCode.toDataURL(
                qrPayload(ballot),
                {
                    errorCorrectionLevel: "H",
                    margin: 2,
                    width: 320
                }
            )
        }))
    );

    return {
        message: "Existing QR batch reused.",
        batch_id: Number(batch.batch_id),
        quantity: ballots.length,
        ballots,
        already_created: true
    };
}

// Generate new batch; protect against duplicate requests.
exports.createBatch = async (req, res) => {
    const electionId = Number(req.body?.election_id);
    const templateId = Number(req.body?.template_id);
    const quantity = Number(req.body?.quantity);
    const requestId = String(req.body?.request_id || "");

    const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (
        !validId(electionId) ||
        !validId(templateId) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 500 ||
        !uuidPattern.test(requestId)
    ) {
        return res.status(400).json({
            message:
                "Valid election, template, quantity (1-500), and request_id required."
        });
    }

    let db;
    let transactionOpen = false;

    try {
        db = await pool.getConnection();

        const previous = await existingBatchResponse(
            db,
            requestId,
            electionId,
            templateId,
            quantity
        );

        if (previous) {
            return res.status(
                previous.conflict ? 409 : 200
            ).json(
                previous.conflict
                    ? {
                        message:
                            "Request ID was used with different batch details."
                    }
                    : previous
            );
        }

        const [templates] = await db.execute(
            `SELECT template_id
             FROM ballot_templates
             WHERE template_id = ?
               AND election_id = ?
             LIMIT 1`,
            [templateId, electionId]
        );

        if (!templates.length) {
            return res.status(404).json({
                message: "Ballot template not found."
            });
        }

        await db.beginTransaction();
        transactionOpen = true;

        let batchResult;

        try {
            [batchResult] = await db.execute(
                `INSERT INTO ballot_print_batches
                 (election_id, template_id, quantity, request_id)
                 VALUES (?, ?, ?, ?)`,
                [
                    electionId,
                    templateId,
                    quantity,
                    requestId
                ]
            );
        } catch (error) {
            if (error.code !== "ER_DUP_ENTRY") {
                throw error;
            }

            await db.rollback();
            transactionOpen = false;

            const previousAfterRace =
                await existingBatchResponse(
                    db,
                    requestId,
                    electionId,
                    templateId,
                    quantity
                );

            if (!previousAfterRace) {
                throw error;
            }

            return res.status(
                previousAfterRace.conflict ? 409 : 200
            ).json(
                previousAfterRace.conflict
                    ? {
                        message:
                            "Request ID was used with different batch details."
                    }
                    : previousAfterRace
            );
        }

        const batchId = batchResult.insertId;
        const ballots = [];

        for (let i = 0; i < quantity; i++) {
            const ballotId = crypto.randomUUID();

            await db.execute(
                `INSERT INTO issued_ballots
                 (ballot_id, batch_id, election_id, template_id)
                 VALUES (?, ?, ?, ?)`,
                [
                    ballotId,
                    batchId,
                    electionId,
                    templateId
                ]
            );

            ballots.push({
                ballot_id: ballotId,
                election_id: electionId,
                template_id: templateId
            });
        }

        await db.commit();
        transactionOpen = false;

        const result = await Promise.all(
            ballots.map(async ballot => ({
                ballot_id: ballot.ballot_id,
                qr_code: await QRCode.toDataURL(
                    qrPayload(ballot),
                    {
                        errorCorrectionLevel: "H",
                        margin: 2,
                        width: 320
                    }
                )
            }))
        );

        return res.status(201).json({
            message: "Ballot batch generated.",
            batch_id: batchId,
            quantity: result.length,
            ballots: result,
            already_created: false
        });

    } catch (error) {
        if (db && transactionOpen) {
            try {
                await db.rollback();
            } catch (_) {}
        }

        console.error("QR batch error:", error);

        return res.status(500).json({
            message: "Failed to generate ballot batch."
        });

    } finally {
        if (db) db.release();
    }
};

// Existing batch for reprint. No new IDs.
exports.getBatch = async (req, res) => {
    const batchId = Number(req.params.batch_id);

    if (!validId(batchId)) {
        return res.status(400).json({
            message: "Invalid batch ID."
        });
    }

    try {
        const [rows] = await pool.execute(
            `SELECT ballot_id,
                    election_id,
                    template_id,
                    status
             FROM issued_ballots
             WHERE batch_id = ?
             ORDER BY created_at, ballot_id`,
            [batchId]
        );

        if (!rows.length) {
            return res.status(404).json({
                message: "Batch not found."
            });
        }

        const ballots = await Promise.all(
            rows.map(async row => ({
                ...row,
                qr_code: await QRCode.toDataURL(
                    qrPayload(row),
                    {
                        errorCorrectionLevel: "H",
                        margin: 2,
                        width: 320
                    }
                )
            }))
        );

        return res.json({
            batch_id: batchId,
            quantity: ballots.length,
            ballots
        });

    } catch (error) {
        console.error("Get batch error:", error);

        return res.status(500).json({
            message: "Failed to load batch."
        });
    }
};

// List existing QR batches for an election.
exports.listBatchesByElection = async (req, res) => {
    const electionId = Number(req.params.election_id);
    const templateIdRaw = req.query.template_id;

    if (
        !Number.isSafeInteger(electionId) ||
        electionId <= 0
    ) {
        return res.status(400).json({
            message: "Invalid election ID."
        });
    }

    let templateId = null;

    if (
        templateIdRaw !== undefined &&
        templateIdRaw !== ""
    ) {
        templateId = Number(templateIdRaw);

        if (
            !Number.isSafeInteger(templateId) ||
            templateId <= 0
        ) {
            return res.status(400).json({
                message: "Invalid template ID."
            });
        }
    }

    try {
        const sql = `
            SELECT
                b.batch_id,
                b.election_id,
                b.template_id,
                t.template_name,
                t.paper_size,
                b.quantity,
                b.created_at,
                COUNT(i.ballot_id) AS registered_count
            FROM ballot_print_batches b
            INNER JOIN ballot_templates t
                ON t.template_id = b.template_id
               AND t.election_id = b.election_id
            LEFT JOIN issued_ballots i
                ON i.batch_id = b.batch_id
            WHERE b.election_id = ?
            ${
                templateId !== null
                    ? "AND b.template_id = ?"
                    : ""
            }
            GROUP BY
                b.batch_id,
                b.election_id,
                b.template_id,
                t.template_name,
                t.paper_size,
                b.quantity,
                b.created_at
            ORDER BY
                b.created_at DESC,
                b.batch_id DESC
        `;

        const params = templateId !== null
            ? [electionId, templateId]
            : [electionId];

        const [rows] = await pool.execute(sql, params);

        return res.status(200).json({
            election_id: electionId,
            template_id: templateId,
            batches: rows.map(row => ({
                batch_id: Number(row.batch_id),
                election_id: Number(row.election_id),
                template_id: Number(row.template_id),
                template_name: row.template_name,
                paper_size: row.paper_size,
                quantity: Number(row.quantity),
                registered_count: Number(
                    row.registered_count
                ),
                created_at: row.created_at
            }))
        });

    } catch (error) {
        console.error(
            "List QR batches error:",
            error
        );

        return res.status(500).json({
            message:
                "Failed to load registered QR batches."
        });
    }
};

// Confirm original print or reprint.
exports.confirmPrint = async (req, res) => {
    const batchId = Number(req.params.batch_id);

    const { event_id, print_type } = req.body || {};

    const quantity = Number(req.body?.quantity);

    const validEventId =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (
        !validId(batchId) ||
        !validEventId.test(String(event_id || "")) ||
        !["ORIGINAL", "REPRINT"].includes(print_type) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 500
    ) {
        return res.status(400).json({
            message: "Invalid print confirmation."
        });
    }

    let db;

    try {
        db = await pool.getConnection();

        await db.beginTransaction();

        const [existing] = await db.execute(
            `SELECT
                event_id,
                batch_id,
                print_type,
                quantity
             FROM ballot_print_logs
             WHERE event_id = ?`,
            [event_id]
        );

        if (existing.length) {
            const previous = existing[0];

            if (
                Number(previous.batch_id) !== batchId ||
                previous.print_type !== print_type ||
                Number(previous.quantity) !== quantity
            ) {
                await db.rollback();

                return res.status(409).json({
                    message:
                        "Print event ID already used with different details."
                });
            }

            await db.commit();

            return res.json({
                message: "Print already recorded.",
                event_id,
                already_recorded: true
            });
        }

        const [batches] = await db.execute(
            `SELECT
                batch_id,
                election_id,
                quantity
             FROM ballot_print_batches
             WHERE batch_id = ?
             FOR UPDATE`,
            [batchId]
        );

        if (!batches.length) {
            await db.rollback();

            return res.status(404).json({
                message: "Print batch not found."
            });
        }

        const batch = batches[0];

        if (quantity !== Number(batch.quantity)) {
            await db.rollback();

            return res.status(400).json({
                message:
                    "Print the entire batch; quantity must equal the registered batch size."
            });
        }

        const [originals] = await db.execute(
            `SELECT event_id
             FROM ballot_print_logs
             WHERE batch_id = ?
               AND print_type = 'ORIGINAL'
             LIMIT 1`,
            [batchId]
        );

        if (
            print_type === "ORIGINAL" &&
            originals.length
        ) {
            await db.rollback();

            return res.status(409).json({
                message:
                    "Original print already confirmed. Use REPRINT."
            });
        }

        if (
            print_type === "REPRINT" &&
            !originals.length
        ) {
            await db.rollback();

            return res.status(409).json({
                message:
                    "Confirm the original printing first."
            });
        }

        await db.execute(
            `INSERT INTO ballot_print_logs
             (
                event_id,
                batch_id,
                election_id,
                print_type,
                quantity
             )
             VALUES (?, ?, ?, ?, ?)`,
            [
                event_id,
                batchId,
                batch.election_id,
                print_type,
                quantity
            ]
        );

        await db.commit();

        return res.status(201).json({
            message:
                "Physical print quantity recorded.",
            event_id,
            quantity
        });

    } catch (error) {
        if (db) {
            try {
                await db.rollback();
            } catch (_) {}
        }

        console.error("Confirm print error:", error);

        return res.status(500).json({
            message:
                "Failed to save print confirmation."
        });

    } finally {
        if (db) db.release();
    }
};

// Registered, original, reprint and overall totals.
exports.getPrintSummary = async (req, res) => {
    const electionId = Number(
        req.params.election_id
    );

    if (!validId(electionId)) {
        return res.status(400).json({
            message: "Invalid election ID."
        });
    }

    try {
        const [registered] = await pool.execute(
            `SELECT COUNT(*) AS count
             FROM issued_ballots
             WHERE election_id = ?`,
            [electionId]
        );

        const [printed] = await pool.execute(
            `SELECT
                COALESCE(
                    SUM(
                        CASE
                            WHEN print_type = 'ORIGINAL'
                            THEN quantity
                            ELSE 0
                        END
                    ),
                    0
                ) AS original,

                COALESCE(
                    SUM(
                        CASE
                            WHEN print_type = 'REPRINT'
                            THEN quantity
                            ELSE 0
                        END
                    ),
                    0
                ) AS reprints,

                COALESCE(
                    SUM(quantity),
                    0
                ) AS overall

             FROM ballot_print_logs
             WHERE election_id = ?`,
            [electionId]
        );

        return res.json({
            election_id: electionId,

            registered_unique: Number(
                registered[0].count
            ),

            original: Number(
                printed[0].original
            ),

            reprints: Number(
                printed[0].reprints
            ),

            overall: Number(
                printed[0].overall
            ),

            unit: "individual A5 ballots",

            note:
                "Counts are operator-confirmed, not printer-verified. Earlier print jobs are not backfilled."
        });

    } catch (error) {
        console.error(
            "Print summary error:",
            error
        );

        return res.status(500).json({
            message:
                "Failed to load print summary."
        });
    }
};
