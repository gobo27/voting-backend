
"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../../config/db");

const {
    sendPasswordResetOtpEmail
} = require("../super admin/adduser/emailjs.server");

const TEST_EMAIL = "vmaldea27@gmail.com";
const OTP_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const COOLDOWN_SECONDS = 60;
const RESET_TOKEN_MINUTES = 5;

const ALLOWED_ROLES = [
    "adviser",
    "committee",
    "super_admin"
];

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
        password.length <= 128 &&
        Buffer.byteLength(password, "utf8") <= 72;
}

function validResetToken(token) {
    return typeof token === "string" &&
        /^[a-f0-9]{64}$/.test(token);
}

// Request OTP
exports.requestReset = async (req, res) => {
    const email = normalizeEmail(req.body?.email);

    if (!validEmail(email)) {
        return res.status(400).json({
            message: "Enter a valid email address."
        });
    }

    //  to testing
    if (!isTestAccount(email)) {
        return res.json({
            message: genericMessage
        });
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

        if (
            !users.length ||
            !ALLOWED_ROLES.includes(users[0].role)
        ) {
            return res.json({
                message: genericMessage
            });
        }

        const user = users[0];

        conn = await db.getConnection();
        await conn.beginTransaction();


        await conn.execute(
            `INSERT IGNORE INTO password_reset_otps
             (user_id, otp_hash, expires_at, requested_at)
             VALUES (
                 ?,
                 '',
                 NOW(),
                 DATE_SUB(NOW(), INTERVAL 1 DAY)
             )`,
            [user.id]
        );

        const [records] = await conn.execute(
            `SELECT
                 user_id,
                 TIMESTAMPDIFF(
                     SECOND,
                     requested_at,
                     NOW()
                 ) AS seconds_since
             FROM password_reset_otps
             WHERE user_id = ?
             FOR UPDATE`,
            [user.id]
        );

        if (!records.length) {
            await conn.rollback();
            conn.release();
            conn = null;

            return res.status(500).json({
                message: "Unable to prepare password reset."
            });
        }

        // Limit the OTP request
        if (
            records[0].seconds_since !== null &&
            Number(records[0].seconds_since) < COOLDOWN_SECONDS
        ) {
            await conn.rollback();
            conn.release();
            conn = null;

            return res.json({
                message: genericMessage
            });
        }

        const otp = String(
            crypto.randomInt(0, 1000000)
        ).padStart(6, "0");

        const otpHash = await bcrypt.hash(otp, 10);

        await conn.execute(
            `UPDATE password_reset_otps
             SET otp_hash = ?,
                 expires_at = DATE_ADD(
                     NOW(),
                     INTERVAL ? MINUTE
                 ),
                 requested_at = NOW(),
                 attempts = 0,
                 verified_token_hash = NULL,
                 verified_expires_at = NULL
             WHERE user_id = ?`,
            [
                otpHash,
                OTP_MINUTES,
                user.id
            ]
        );

        await conn.commit();
        conn.release();
        conn = null;

        // send ang OTP gamit ang EmailJS
        try {
            const result = await sendPasswordResetOtpEmail({
                to: user.email,
                otp
            });

            if (result?.sent !== true) {
                throw new Error(
                    "EmailJS did not accept the OTP email."
                );
            }

        } catch (emailError) {
            console.error(
                "EMAILJS OTP ERROR:",
                emailError
            );

            // I-disable ang OTP kapag failed ang email
            try {
                await db.execute(
                    `UPDATE password_reset_otps
                     SET expires_at = NOW(),
                         otp_hash = '',
                         verified_token_hash = NULL,
                         verified_expires_at = NULL
                     WHERE user_id = ?
                       AND otp_hash = ?`,
                    [user.id, otpHash]
                );
            } catch (invalidateError) {
                console.error(
                    "OTP INVALIDATION ERROR:",
                    invalidateError
                );
            }

            return res.status(503).json({
                message:
                    "Email service is unavailable. Try again later."
            });
        }

        return res.json({
            message: genericMessage
        });

    } catch (error) {
        if (conn) {
            await conn.rollback().catch(() => {});
            conn.release();
        }

        console.error(
            "PASSWORD RESET REQUEST ERROR:",
            error
        );

        return res.status(500).json({
            message: "Unable to process request."
        });
    }
};

// to Verify 6-digit OTP
exports.verifyReset = async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || "").trim();

    if (
        !isTestAccount(email) ||
        !/^\d{6}$/.test(otp)
    ) {
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
             INNER JOIN users u
                 ON u.id = p.user_id
             WHERE u.email = ?
             FOR UPDATE`,
            [email]
        );

        const record = rows[0];

        if (
            !record ||
            Number(record.attempts) >= MAX_ATTEMPTS ||
            Number(record.is_valid) !== 1
        ) {
            await conn.rollback();
            conn.release();
            conn = null;

            return res.status(400).json({
                message: "Invalid or expired verification code."
            });
        }

        // to compare ang OTP sa stored bcrypt hash
        const matches = record.otp_hash
            ? await bcrypt.compare(
                otp,
                record.otp_hash
            )
            : false;

        if (!matches) {
            await conn.execute(
                `UPDATE password_reset_otps
                 SET attempts = attempts + 1
                 WHERE user_id = ?`,
                [record.user_id]
            );

            await conn.commit();
            conn.release();
            conn = null;

            return res.status(400).json({
                message: "Invalid or expired verification code."
            });
        }

        // Gumawa ng one-time reset authorization token
        const resetToken = crypto
            .randomBytes(32)
            .toString("hex");

        const resetTokenHash = sha256(resetToken);

        await conn.execute(
            `UPDATE password_reset_otps
             SET otp_hash = '',
                 expires_at = NOW(),
                 verified_token_hash = ?,
                 verified_expires_at = DATE_ADD(
                     NOW(),
                     INTERVAL ? MINUTE
                 )
             WHERE user_id = ?`,
            [
                resetTokenHash,
                RESET_TOKEN_MINUTES,
                record.user_id
            ]
        );

        await conn.commit();
        conn.release();
        conn = null;

        return res.json({
            message: "OTP verified successfully.",
            resetToken
        });

    } catch (error) {
        if (conn) {
            await conn.rollback().catch(() => {});
            conn.release();
        }

        console.error(
            "OTP VERIFICATION ERROR:",
            error
        );

        return res.status(500).json({
            message: "Unable to verify code."
        });
    }
};

// Confirm at i-save new password
exports.confirmReset = async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const resetToken = req.body?.resetToken;

    if (
        !isTestAccount(email) ||
        !validPassword(password) ||
        !validResetToken(resetToken)
    ) {
        return res.status(400).json({
            message:
                "Invalid reset request. Password must be 12–128 characters and at most 72 UTF-8 bytes."
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
                 (p.verified_expires_at > NOW())
                     AS token_is_valid
             FROM password_reset_otps p
             INNER JOIN users u
                 ON u.id = p.user_id
             WHERE u.email = ?
             FOR UPDATE`,
            [email]
        );

        const record = rows[0];
        const suppliedHash = sha256(resetToken);

        const storedHash =
            record?.verified_token_hash;

        // Secure comparison to reset token
        const authorized =
            record &&
            typeof storedHash === "string" &&
            /^[a-f0-9]{64}$/i.test(storedHash) &&
            Number(record.token_is_valid) === 1 &&
            crypto.timingSafeEqual(
                Buffer.from(storedHash, "hex"),
                Buffer.from(suppliedHash, "hex")
            );

        if (!authorized) {
            await conn.rollback();
            conn.release();
            conn = null;

            return res.status(400).json({
                message:
                    "Reset session expired. Request a new OTP."
            });
        }

        // Hash ang password bago i-save sa database
        const hashedPassword = await bcrypt.hash(
            password,
            12
        );

        await conn.execute(
            `UPDATE users
             SET password = ?,
                 must_change_password = 0
             WHERE id = ?`,
            [
                hashedPassword,
                record.user_id
            ]
        );

        // Burahin ang used reset record
        await conn.execute(
            `DELETE FROM password_reset_otps
             WHERE user_id = ?`,
            [record.user_id]
        );

        await conn.commit();
        conn.release();
        conn = null;

        return res.json({
            message:
                "Password updated successfully. You can now log in."
        });

    } catch (error) {
        if (conn) {
            await conn.rollback().catch(() => {});
            conn.release();
        }

        console.error(
            "PASSWORD RESET CONFIRMATION ERROR:",
            error
        );

        return res.status(500).json({
            message: "Unable to update password."
        });
    }
};
