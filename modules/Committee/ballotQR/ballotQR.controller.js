
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

exports.getElectionScopes = async (req, res) => {
    const electionId = Number(req.params.election_id);

    if (!validId(electionId)) {
        return res.status(400).json({
            message: "Invalid election ID."
        });
    }

    try {
        const [rows] = await pool.execute(
            `SELECT
                s.scope_id,
                s.scope_type,
                s.scope_code,
                s.scope_name,
                e.school_level,
                b.batch_id AS existing_batch_id,
                b.quantity AS existing_quantity
             FROM election_scopes s
             INNER JOIN elections e
                ON e.election_id = s.election_id
             LEFT JOIN ballot_print_batches b
                ON b.election_id = s.election_id
               AND b.scope_id = s.scope_id
             WHERE s.election_id = ?
               AND s.is_active = 1
             ORDER BY s.scope_id`,
            [electionId]
        );

        return res.json({ scopes: rows });

    } catch (error) {
        console.error("Load scopes error:", error);

        return res.status(500).json({
            message: "Failed to load election scopes."
        });
    }
};


// Same request_id, same registered QR batch.

async function existingBatchResponse(
    db,
    requestId,
    electionId,
    templateId,
    quantity,
    batchType,
    scopeId
) {
    const [batches] = await db.execute(
        `SELECT batch_id, election_id, template_id,
                quantity, batch_type, scope_id
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
        Number(batch.quantity) !== quantity ||
        batch.batch_type !== batchType ||
        Number(batch.scope_id) !== scopeId
    ) {
        return { conflict: true };
    }


    const [rows] = await db.execute(
        `SELECT ballot_id, election_id, template_id,
            scope_id, serial_number, ballot_number
            FROM issued_ballots
            WHERE batch_id = ?
            ORDER BY ballot_number ASC,
            created_at ASC,
            ballot_id ASC`,
        [batch.batch_id]
    );


    if (rows.length !== quantity) {
        throw new Error("Unexpected registered ballot count.");
    }

    const ballots = await Promise.all(
        rows.map(async ballot => ({
            ballot_id: ballot.ballot_id,
            scope_id: Number(ballot.scope_id),
            serial_number: ballot.serial_number,
            ballot_number: ballot.ballot_number,
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
        already_created: true,
        batch_type: batchType
    };
}


// Generate new batch; protect against duplicate requests.

exports.createBatch = async (req, res) => {
    const electionId = Number(req.body?.election_id);
    const templateId = Number(req.body?.template_id);
    const scopeId = Number(req.body?.scope_id);
    const quantity = Number(req.body?.quantity);
    const requestId = String(req.body?.request_id || "");
    const batchType = req.body?.batch_type ?? "ORIGINAL";

    const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (
        !validId(electionId) ||
        !validId(templateId) ||
        !validId(scopeId) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 500 ||
        !uuidPattern.test(requestId) ||
        batchType !== "ORIGINAL"
    ) {
        return res.status(400).json({
            message:
                "Valid election, template, scope, " +
                "quantity (1-500) and request ID required. " +
                "Additional batches are not allowed."
        });
    }

    let db;
    let transactionOpen = false;

    try {
        db = await pool.getConnection();

        // Safe retry: same request ID = same batch.
        const previous = await existingBatchResponse(
            db, requestId, electionId,
            templateId, quantity, batchType, scopeId
        );

        if (previous) {
            return res.status(
                previous.conflict ? 409 : 200
            ).json(
                previous.conflict
                    ? { message: "Request ID conflict." }
                    : previous
            );
        }

        await db.beginTransaction();
        transactionOpen = true;

        // Lock election during generation.
        const [[election]] = await db.execute(
            `SELECT election_id, school_level,
                    status, is_active,
                    scanning_open, is_current, archived_at
             FROM elections
             WHERE election_id = ?
             FOR UPDATE`,
            [electionId]
        );

        if (
            !election ||
            Number(election.is_current) !== 1 ||
            election.archived_at !== null ||
            String(election.status || "").toLowerCase()
            === "completed" ||
            Number(election.is_active) === 1 ||
            Number(election.scanning_open) === 1
        ) {
            await db.rollback();
            transactionOpen = false;

            return res.status(409).json({
                message:
                    "Cannot generate ballots while voting " +
                    "or scanning is active, or for an " +
                    "old/completed election."
            });
        }

        // Verify saved ballot template.
        const [[template]] = await db.execute(
            `SELECT template_id
             FROM ballot_templates
             WHERE template_id = ?
               AND election_id = ?`,
            [templateId, electionId]
        );

        if (!template) {
            await db.rollback();
            transactionOpen = false;

            return res.status(404).json({
                message: "Ballot template not found."
            });
        }

        // Verify department / grade belongs to election.
        const [[scope]] = await db.execute(
            `SELECT scope_id, scope_code, scope_type
             FROM election_scopes
             WHERE scope_id = ?
               AND election_id = ?
               AND is_active = 1`,
            [scopeId, electionId]
        );

        const expectedType =
            String(election.school_level).toLowerCase()
                === "college"
                ? "department"
                : "grade";

        if (
            !scope ||
            scope.scope_type !== expectedType
        ) {
            await db.rollback();
            transactionOpen = false;

            return res.status(400).json({
                message:
                    "Invalid department/grade for this election."
            });
        }

        // Existing legacy batches must not be changed.
        const [[legacy]] = await db.execute(
            `SELECT COUNT(*) AS total
             FROM ballot_print_batches
             WHERE election_id = ?
               AND scope_id IS NULL`,
            [electionId]
        );

        if (Number(legacy.total) > 0) {
            await db.rollback();
            transactionOpen = false;

            return res.status(409).json({
                message:
                    "This election has existing unscoped " +
                    "ballots. New generation is blocked. " +
                    "Existing ballots remain unchanged."
            });
        }

        // Only one batch per department / grade.
        const [existing] = await db.execute(
            `SELECT batch_id
             FROM ballot_print_batches
             WHERE election_id = ?
               AND scope_id = ?
             LIMIT 1`,
            [electionId, scopeId]
        );

        if (existing.length) {
            await db.rollback();
            transactionOpen = false;

            return res.status(409).json({
                message:
                    "This department/grade already has a " +
                    "registered ballot batch. Reprint the " +
                    "existing batch instead.",
                existing_batch_id:
                    Number(existing[0].batch_id)
            });
        }

        // Continuous ballot numbering per election.
        const [[numbering]] = await db.execute(
            `SELECT
        COALESCE(MAX(ballot_number), 0) AS last_number,
        COUNT(*) - COUNT(ballot_number) AS unnumbered
     FROM issued_ballots
     WHERE election_id = ?`,
            [electionId]
        );

        // Protect previously registered ballots.
        if (Number(numbering.unnumbered) > 0) {
            await db.rollback();
            transactionOpen = false;

            return res.status(409).json({
                message:
                    "This election contains legacy ballot numbers."
            });
        }

        const lastBallotNumber =
            Number(numbering.last_number);


        // Register exactly one original batch.
        const [insert] = await db.execute(
            `INSERT INTO ballot_print_batches
                (election_id, template_id, quantity,
                 request_id, batch_type, scope_id)
             VALUES (?, ?, ?, ?, 'ORIGINAL', ?)`,
            [
                electionId,
                templateId,
                quantity,
                requestId,
                scopeId
            ]
        );

        const batchId = insert.insertId;
        const ballots = [];


        for (let i = 0; i < quantity; i++) {
            const ballotId = crypto.randomUUID();

            // Continue numbering across departments and grades.
            const ballotNumber = lastBallotNumber + i + 1;

            const serialNumber =
                `CV-${electionId}-` +
                `${String(scope.scope_code).toUpperCase()}-` +
                `${String(ballotNumber).padStart(5, "0")}`;

            await db.execute(
                `INSERT INTO issued_ballots
            (
                ballot_id,
                batch_id,
                election_id,
                template_id,
                scope_id,
                serial_number,
                ballot_number
            )
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    ballotId,
                    batchId,
                    electionId,
                    templateId,
                    scopeId,
                    serialNumber,
                    ballotNumber
                ]
            );

            ballots.push({
                ballot_id: ballotId,
                election_id: electionId,
                template_id: templateId,
                scope_id: scopeId,
                serial_number: serialNumber,
                ballot_number: ballotNumber
            });
        }

        await db.commit();
        transactionOpen = false;

        const result = await Promise.all(
            ballots.map(async ballot => ({
                ballot_id: ballot.ballot_id,
                scope_id: ballot.scope_id,
                serial_number: ballot.serial_number,
                ballot_number: ballot.ballot_number,
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
            batch_id: Number(batchId),
            quantity: result.length,
            ballots: result,
            already_created: false,
            batch_type: "ORIGINAL"
        });

    } catch (error) {
        if (db && transactionOpen) {
            try {
                await db.rollback();
            } catch (_) { }
        }

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                message:
                    "A ballot batch already exists for " +
                    "this scope or request."
            });
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
            `SELECT
                ballot_id,
                election_id,
                template_id,
                scope_id,
                serial_number,
                ballot_number,
                status
                FROM issued_ballots
                WHERE batch_id = ?
                 ORDER BY ballot_number ASC,
                 created_at ASC,
                 ballot_id ASC`,
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
                b.batch_type,
                b.created_at,
                COUNT(i.ballot_id) AS registered_count
            FROM ballot_print_batches b
            INNER JOIN ballot_templates t
                ON t.template_id = b.template_id
               AND t.election_id = b.election_id
            LEFT JOIN issued_ballots i
                ON i.batch_id = b.batch_id
            WHERE b.election_id = ?
            ${templateId !== null
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
                b.batch_type,
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
                batch_type: row.batch_type,
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
            } catch (_) { }
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
    const electionId = Number(req.params.election_id);

    if (!validId(electionId)) {
        return res.status(400).json({
            message: "Invalid election ID."
        });
    }

    try {
        // Bilang ng unique registered QR ballots
        const [registered] = await pool.execute(
            `SELECT COUNT(*) AS count
             FROM issued_ballots
             WHERE election_id = ?`,
            [electionId]
        );

        // Hiwalay ang Original at Additional gamit ang batch_type
        const [printed] = await pool.execute(
            `SELECT
                COALESCE(SUM(
                    CASE
                        WHEN b.batch_type = 'ORIGINAL'
                         AND l.print_type = 'ORIGINAL'
                        THEN l.quantity
                        ELSE 0
                    END
                ), 0) AS original,

                COALESCE(SUM(
                    CASE
                        WHEN b.batch_type = 'ADDITIONAL'
                         AND l.print_type = 'ORIGINAL'
                        THEN l.quantity
                        ELSE 0
                    END
                ), 0) AS additional

             FROM ballot_print_logs l
             INNER JOIN ballot_print_batches b
                 ON b.batch_id = l.batch_id
             WHERE l.election_id = ?`,
            [electionId]
        );

        const original = Number(printed[0].original);
        const additional = Number(printed[0].additional);

        return res.json({
            election_id: electionId,

            initial_printed: original,
            additional_printed: additional,

            original,
            additional,
            reprints: 0,
            overall: original + additional,

            registered_unique: Number(registered[0].count),

            unit: "individual ballots (A4/A5)",
            note: "Counts are operator-confirmed, not printer-verified."
        });

    } catch (error) {
        console.error("Print summary error:", error);

        return res.status(500).json({
            message: "Failed to load print summary."
        });
    }
};
