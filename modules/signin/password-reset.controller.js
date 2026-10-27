
"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../../config/db");

// Adjust this path to the actual location of resend.server.js
const { sendPasswordResetOtpEmail } = require("../super admin/adduser/resend.server");

const TEST_EMAIL = "vmaldea27@gmail.com";
const OTP_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const COOLDOWN_SECONDS = 60;

const genericMessage =
    "If this account is eligible, a verification code will be sent.";

const validEmail = value =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const sha256 = value =>
    crypto.createHash("sha256")
        .update(value)
        .digest("hex");

function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}

function isTestAccount(email) {
    return email === TEST_EMAIL;
}

function validPassword(password) {
    return typeof password === "string" &&
        password.length >= 12 &&
        password.length <= 128;
}

// POST /api/signin/password-reset/request
exports.requestReset = async (req, res) => {
    const email = normalizeEmail(req.body?.email);

    if (!validEmail(email)) {
        return res.status(400).json({
            message: "Enter a valid email address."
        });
    }

    // Only the designated test account may reset.
    if (!isTestAccount(email)) {
        return res.json({ message: genericMessage });
    }

    let conn;

    try {
        const [users] = await db.execute(
            `SELECT id, email, role
             FROM users
             WHERE email = ?
             LIMIT 1`,
            [email]
        );

        if (!users.length ||
            !["adviser", "committee", "super_admin"].includes(users[0].role)) {
            return res.json({ message: genericMessage });
        }

        const user = users[0];

        conn = await db.getConnection();
        await conn.beginTransaction();

        // Ensure one reset record per user.
        await conn.execute(
            `INSERT IGNORE INTO password_reset_otps
             (user_id, otp_hash, expires_at, requested_at)
             VALUES (?, '', NOW(), DATE_SUB(NOW(), INTERVAL 1 DAY))`,
            [user.id]
        );

        const [records] = await conn.execute(
            `SELECT user_id,
                    TIMESTAMPDIFF(
                        SECOND, requested_at, NOW()
                    ) AS seconds_since
             FROM password_reset_otps
             WHERE user_id = ?
             FOR UPDATE`,
            [user.id]
        );

        if (records[0].seconds_since < COOLDOWN_SECONDS) {
            await conn.rollback();
            return res.json({ message: genericMessage });
        }

        const otp = String(
            crypto.randomInt(0, 1000000)
        ).padStart(6, "0");

        const otpHash = await bcrypt.hash(otp, 10);

        await conn.execute(
            `UPDATE password_reset_otps
             SET otp_hash = ?,
                 expires_at = DATE_ADD(
                     NOW(), INTERVAL 10 MINUTE
                 ),
                 requested_at = NOW(),
                 attempts = 0,
                 verified_token_hash = NULL,
                 verified_expires_at = NULL
             WHERE user_id = ?`,
            [otpHash, user.id]
        );

        await conn.commit();
        conn.release();
        conn = null;

        try {
            await sendPasswordResetOtpEmail({
                to: TEST_EMAIL,
                otp
            });
        } catch (emailError) {
            console.error(
                "OTP delivery failed:",
                emailError.message
            );

            // Do not leave an active OTP after failed delivery.
            await db.execute(
                `UPDATE password_reset_otps
                 SET expires_at = NOW(),
                     otp_hash = '',
                     verified_token_hash = NULL
                 WHERE user_id = ? AND otp_hash = ?`,
                [user.id, otpHash]
            );

            return res.status(503).json({
                message:
                    "Email service is unavailable. Try again later."
            });
        }

        return res.json({ message: genericMessage });

    } catch (error) {
        if (conn) {
            await conn.rollback().catch(() => { });
            conn.release();
        }

        console.error("Password reset request error:", error);
        return res.status(500).json({
            message: "Unable to process request."
        });
    }
};

// POST /api/signin/password-reset/verify
exports.verifyReset = async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || "").trim();

    if (!isTestAccount(email) || !/^\d{6}$/.test(otp)) {
        return res.status(400).json({
            message: "Invalid or expired verification code."
        });
    }

    let conn;

    try {
        conn = await db.getConnection();
        await conn.beginTransaction();

        const [rows] = await conn.execute(
            `SELECT
        p.user_id,
        p.otp_hash,
        p.attempts,
        (p.expires_at > NOW()) AS is_valid
     FROM password_reset_otps p
     INNER JOIN users u ON u.id = p.user_id
     WHERE u.email = ?
     FOR UPDATE`,
            [email]
        );

        const record = rows[0];

        if (!record ||
            record.attempts >= MAX_ATTEMPTS ||
            Number(record.is_valid) !== 1) {
            await conn.rollback();
            return res.status(400).json({
                message: "Invalid or expired verification code."
            });
        }

        const matches = record.otp_hash
            ? await bcrypt.compare(otp, record.otp_hash)
            : false;

        if (!matches) {
            await conn.execute(
                `UPDATE password_reset_otps
                 SET attempts = attempts + 1
                 WHERE user_id = ?`,
                [record.user_id]
            );

            await conn.commit();

            return res.status(400).json({
                message: "Invalid or expired verification code."
            });
        }

        // A separate one-time token authorizes the password change.
        const resetToken = crypto.randomBytes(32).toString("hex");

        await conn.execute(
            `UPDATE password_reset_otps
             SET otp_hash = '',
                 verified_token_hash = ?,
                 verified_expires_at =
                     DATE_ADD(NOW(), INTERVAL 5 MINUTE)
             WHERE user_id = ?`,
            [sha256(resetToken), record.user_id]
        );

        await conn.commit();

        return res.json({
            message: "OTP verified successfully.",
            resetToken
        });

    } catch (error) {
        if (conn) await conn.rollback().catch(() => { });
        console.error("OTP verification error:", error);

        return res.status(500).json({
            message: "Unable to verify code."
        });
    } finally {
        if (conn) conn.release();
    }
};

// POST /api/signin/password-reset/confirm
exports.confirmReset = async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const resetToken = req.body?.resetToken;

    if (!isTestAccount(email) ||
        !validPassword(password) ||
        typeof resetToken !== "string" ||
        !/^[a-f0-9]{64}$/.test(resetToken)) {
        return res.status(400).json({
            message:
                "Invalid reset request. Password must be 12–128 characters."
        });
    }

    let conn;

    try {
        conn = await db.getConnection();
        await conn.beginTransaction();

        const [rows] = await conn.execute(
            `SELECT
        p.user_id,
        p.verified_token_hash,
        (p.verified_expires_at > NOW()) AS token_is_valid
     FROM password_reset_otps p
     INNER JOIN users u ON u.id = p.user_id
     WHERE u.email = ?
     FOR UPDATE`,
            [email]
        );

        const record = rows[0];
        const suppliedHash = sha256(resetToken);

        const authorized =
            record &&
            record.verified_token_hash &&
            Number(record.token_is_valid) === 1 &&
            crypto.timingSafeEqual(
                Buffer.from(record.verified_token_hash, "hex"),
                Buffer.from(sha256(resetToken), "hex")
            );
        record.verified_expires_at &&
            new Date(record.verified_expires_at).getTime() > Date.now();

        if (!authorized) {
            await conn.rollback();

            return res.status(400).json({
                message: "Reset session expired. Request a new OTP."
            });
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        await conn.execute(
             `UPDATE users SET password = ? must_change_password = 0 WHERE id = ?`,
            [hashedPassword, record.user_id]
        );

        await conn.execute(
            "DELETE FROM password_reset_otps WHERE user_id = ?",
            [record.user_id]
        );

        await conn.commit();

        return res.json({
            message:
                "Password updated successfully. You can now log in."
        });

    } catch (error) {
        if (conn) await conn.rollback().catch(() => { });
        console.error("Password reset confirmation error:", error);

        return res.status(500).json({
            message: "Unable to update password."
        });
    } finally {
        if (conn) conn.release();
    }
};
