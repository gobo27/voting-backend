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

// POST /api/ballots/qr/batches
exports.createBatch = async (req, res) => {
    const electionId = Number(req.body.election_id);
    const templateId = Number(req.body.template_id);
    const quantity = Number(req.body.quantity);

    if (
        !validId(electionId) ||
        !validId(templateId) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 500
    ) {
        return res.status(400).json({
            message: "Valid election, template and quantity (1-500) required."
        });
    }

    let db;

    try {
        db = await pool.getConnection();

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

        const [batchResult] = await db.execute(
            `INSERT INTO ballot_print_batches
             (election_id, template_id, quantity)
             VALUES (?, ?, ?)`,
            [electionId, templateId, quantity]
        );

        const batchId = batchResult.insertId;
        const ballots = [];

        for (let i = 0; i < quantity; i++) {
            const ballotId = crypto.randomUUID();

            await db.execute(
                `INSERT INTO issued_ballots
                 (ballot_id, batch_id, election_id, template_id)
                 VALUES (?, ?, ?, ?)`,
                [ballotId, batchId, electionId, templateId]
            );

            ballots.push({
                ballot_id: ballotId,
                election_id: electionId,
                template_id: templateId
            });
        }

        await db.commit();

        const result = [];

        for (const ballot of ballots) {
            const qrCode = await QRCode.toDataURL(
                qrPayload(ballot),
                {
                    errorCorrectionLevel: "H",
                    margin: 2,
                    width: 320
                }
            );

            result.push({
                ballot_id: ballot.ballot_id,
                qr_code: qrCode
            });
        }

        return res.status(201).json({
            message: "Ballot batch generated.",
            batch_id: batchId,
            quantity: result.length,
            ballots: result
        });

    } catch (error) {
        if (db) {
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

// GET /api/ballots/qr/batches/:batch_id
exports.getBatch = async (req, res) => {
    const batchId = Number(req.params.batch_id);

    if (!validId(batchId)) {
        return res.status(400).json({
            message: "Invalid batch ID."
        });
    }

    try {
        const [rows] = await pool.execute(
            `SELECT ballot_id, election_id, template_id, status
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
            ${templateId !== null
                ? "AND b.template_id = ?"
                : ""}
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
                registered_count: Number(row.registered_count),
                created_at: row.created_at
            }))
        });

    } catch (error) {
        console.error("List QR batches error:", error);

        return res.status(500).json({
            message: "Failed to load registered QR batches."
        });
    }
};
