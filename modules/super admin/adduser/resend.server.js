
"use strict";

const { Resend } = require("resend");

// CAMPUSVOTE EMAIL SETTINGS

const TEST_EMAIL = "vmaldea27@gmail.com";

const TEST_SENDER =
    "CampusVote <onboarding@resend.dev>";

const ROLE_LABELS = {
    adviser: "Adviser",
    committee: "Committee",
    super_admin: "Super Administrator"
};

// HELPERS

function escapeHtml(value) {
    return String(value ?? "").replace(
        /[&<>"']/g,
        char => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[char]
    );
}

function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        String(email || "").trim()
    );
}

// EMAIL CONFIGURATION

function getEmailConfig() {
    const apiKey = String(
        process.env.RESEND_API_KEY || ""
    ).trim();

    if (!apiKey) {
        throw new Error(
            "RESEND_API_KEY is missing in environment variables."
        );
    }

    return {
        apiKey,
        from: TEST_SENDER,
        isDevelopment: true,
        testRecipient: TEST_EMAIL
    };
}

// GET EMAIL RECIPIENT

function getRecipient(config, to) {
    const requestedRecipient = String(
        to || ""
    ).trim().toLowerCase();

    if (!validEmail(requestedRecipient)) {
        throw new Error(
            "Invalid recipient email address."
        );
    }

    if (!validEmail(config.testRecipient)) {
        throw new Error(
            "Invalid test recipient email configuration."
        );
    }

    return {
        actualRecipient: config.testRecipient,
        redirected:
            requestedRecipient !== config.testRecipient
    };
}

// MAIN RESEND EMAIL FUNCTION

async function sendEmail({
    to,
    subject,
    html,
    text
}) {
    const config = getEmailConfig();

    const {
        actualRecipient,
        redirected
    } = getRecipient(config, to);

    const resend = new Resend(config.apiKey);

    try {
        const result = await resend.emails.send({
            from: config.from,
            to: [actualRecipient],
            subject: `[TEST] ${subject}`,
            html,
            text
        });

        if (result.error) {
            throw new Error(
                result.error.message ||
                "Resend rejected the email."
            );
        }

        if (!result.data?.id) {
            throw new Error(
                "Resend did not return an email ID."
            );
        }

        console.log(
            "CampusVote test email accepted by Resend."
        );

        return {
            sent: true,
            redirected,
            messageId: result.data.id
        };

    } catch (error) {
        console.error(
            "CampusVote email delivery error:",
            error.message
        );

        throw error;
    }
}

// EMAIL DESIGN HELPERS

function emailHeader(subtitle) {
    return `
        <div style="
            background:#800000;
            color:#ffffff;
            padding:25px;
            text-align:center;
            border-radius:12px 12px 0 0;
        ">
            <h1 style="
                margin:0;
                font-size:26px;
                font-weight:700;
            ">
                CampusVote
            </h1>

            <p style="
                margin:8px 0 0;
                font-size:13px;
                color:#f3e8e8;
            ">
                ${escapeHtml(subtitle)}
            </p>
        </div>
    `;
}

function emailFooter() {
    return `
        <div style="
            text-align:center;
            padding:18px;
            color:#6b7280;
            font-size:12px;
        ">
            CampusVote Administration
        </div>
    `;
}

function emailWrapper(content) {
    return `
        <div style="
            font-family:Arial,Helvetica,sans-serif;
            max-width:520px;
            margin:0 auto;
            background:#ffffff;
            color:#222222;
        ">
            ${content}
        </div>
    `;
}

// SEND ACCOUNT CREDENTIALS

/**
 * Sends credentials for newly created users.
 *
 * During testing, delivery is redirected
 * to the configured test inbox.
 */
async function sendCredentialsEmail({
    to,
    firstName,
    userName,
    password,
    role
}) {
    if (!to) {
        console.warn(
            "sendCredentialsEmail: no recipient."
        );

        return {
            sent: false,
            skipped: true
        };
    }

    const roleLabel =
        ROLE_LABELS[
            String(role || "").toLowerCase()
        ] || String(role || "User");

    const safeName = escapeHtml(firstName);
    const safeUsername = escapeHtml(userName);
    const safePassword = escapeHtml(password);
    const safeRole = escapeHtml(roleLabel);

    const html = emailWrapper(`
        ${emailHeader("Election Management System")}

        <div style="
            padding:28px;
            border:1px solid #e5e7eb;
            border-top:none;
        ">
            <h2 style="
                color:#800000;
                margin-top:0;
            ">
                Welcome, ${safeName}!
            </h2>

            <p>
                Your CampusVote account has been
                created successfully.
            </p>

            <p>
                You have been registered as
                <strong>${safeRole}</strong>.
            </p>

            <p>
                Here are your account credentials:
            </p>

            <table style="
                width:100%;
                border-collapse:collapse;
                margin:20px 0;
                background:#f9fafb;
            ">
                <tr>
                    <td style="
                        padding:12px;
                        border:1px solid #e5e7eb;
                        font-weight:bold;
                    ">
                        Email
                    </td>

                    <td style="
                        padding:12px;
                        border:1px solid #e5e7eb;
                        overflow-wrap:anywhere;
                    ">
                        ${safeUsername}
                    </td>
                </tr>

                <tr>
                    <td style="
                        padding:12px;
                        border:1px solid #e5e7eb;
                        font-weight:bold;
                    ">
                        Role
                    </td>

                    <td style="
                        padding:12px;
                        border:1px solid #e5e7eb;
                    ">
                        ${safeRole}
                    </td>
                </tr>

                <tr>
                    <td style="
                        padding:12px;
                        border:1px solid #e5e7eb;
                        font-weight:bold;
                    ">
                        Temporary Password
                    </td>

                    <td style="
                        padding:12px;
                        border:1px solid #e5e7eb;
                        overflow-wrap:anywhere;
                    ">
                        ${safePassword}
                    </td>
                </tr>
            </table>

            <p style="
                background:#fff1f2;
                color:#991b1b;
                padding:12px;
                border-radius:7px;
                font-size:13px;
                line-height:1.6;
            ">
                For security, please change your
                temporary password after your
                first login.
            </p>

            <p style="
                font-size:13px;
                color:#6b7280;
                margin-top:24px;
            ">
                If you did not expect this account,
                please contact your administrator.
            </p>
        </div>

        ${emailFooter()}
    `);

    const text = `
Welcome to CampusVote, ${firstName}!

Your account has been created successfully.

ACCOUNT DETAILS

Email: ${userName}
Role: ${roleLabel}
Temporary Password: ${password}

Please change your password after logging in.

CampusVote Administration
    `.trim();

    return sendEmail({
        to,
        subject:
            "Your CampusVote Account Credentials",
        html,
        text
    });
}

// SEND PASSWORD RESET OTP

/**
 * Sends a 6-digit password reset OTP.
 *
 * OTP expiration is enforced by the backend.
 */
async function sendPasswordResetOtpEmail({
    to,
    otp
}) {
    if (!to) {
        console.warn(
            "sendPasswordResetOtpEmail: no recipient."
        );

        return {
            sent: false,
            skipped: true
        };
    }

    const code = String(otp || "").trim();

    if (!/^\d{6}$/.test(code)) {
        throw new Error(
            "Password reset OTP must contain 6 digits."
        );
    }

    const html = emailWrapper(`
        ${emailHeader("Password Recovery")}

        <div style="
            padding:28px;
            border:1px solid #e5e7eb;
            border-top:none;
        ">
            <h2 style="
                color:#800000;
                margin-top:0;
            ">
                Password Reset Request
            </h2>

            <p style="line-height:1.7;">
                We received a request to reset
                your CampusVote account password.
            </p>

            <p>
                Use the verification code below:
            </p>

            <div style="
                background:#f3f4f6;
                padding:24px;
                text-align:center;
                border-radius:9px;
                margin:24px 0;
            ">
                <span style="
                    display:inline-block;
                    font-size:32px;
                    font-weight:bold;
                    letter-spacing:7px;
                    color:#800000;
                ">
                    ${escapeHtml(code)}
                </span>
            </div>

            <p style="
                text-align:center;
                font-size:13px;
                color:#6b7280;
            ">
                This code expires in
                <strong>10 minutes</strong>.
            </p>

            <p style="
                background:#fff1f2;
                color:#991b1b;
                padding:13px;
                border-radius:7px;
                font-size:13px;
                line-height:1.7;
            ">
                Never share your verification code.
                If you did not request this reset,
                please ignore this email.
            </p>
        </div>

        ${emailFooter()}
    `);

    const text = `
CampusVote Password Reset

Your verification code is: ${code}

This code expires in 10 minutes.

Never share your verification code.

If you did not request this reset,
please ignore this email.

CampusVote Administration
    `.trim();

    return sendEmail({
        to,
        subject: "CampusVote Password Reset Code",
        html,
        text
    });
}

// EXPORT FUNCTIONS

module.exports = {
    sendCredentialsEmail,
    sendPasswordResetOtpEmail
};
