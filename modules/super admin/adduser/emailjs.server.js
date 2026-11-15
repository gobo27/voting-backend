
"use strict";

const emailjs = require("@emailjs/nodejs");

async function sendCredentialsEmail({
    to,
    firstName,
    userName,
    password,
    role
}) {
    const {
        EMAILJS_SERVICE_ID,
        EMAILJS_TEMPLATE_ID,
        EMAILJS_PUBLIC_KEY,
        EMAILJS_PRIVATE_KEY
    } = process.env;

    if (
        !EMAILJS_SERVICE_ID ||
        !EMAILJS_TEMPLATE_ID ||
        !EMAILJS_PUBLIC_KEY ||
        !EMAILJS_PRIVATE_KEY
    ) {
        throw new Error("EmailJS configuration is incomplete.");
    }

    if (!to || !firstName || !password || !role) {
        throw new Error("Missing account email information.");
    }

    const templateParams = {
        to_name: firstName,
        to_email: to,
        role: role,
        temporary_password: password
    };

    const response = await emailjs.send(
        EMAILJS_SERVICE_ID,
        EMAILJS_TEMPLATE_ID,
        templateParams,
        {
            publicKey: EMAILJS_PUBLIC_KEY,
            privateKey: EMAILJS_PRIVATE_KEY
        }
    );

    return {
        sent: response?.status === 200,
        redirected: false
    };
}

async function sendPasswordResetOtpEmail({ to, otp }) {
    const {
        EMAILJS_SERVICE_ID,
        EMAILJS_OTP_TEMPLATE_ID,
        EMAILJS_PUBLIC_KEY,
        EMAILJS_PRIVATE_KEY
    } = process.env;

    if (
        !EMAILJS_SERVICE_ID ||
        !EMAILJS_OTP_TEMPLATE_ID ||
        !EMAILJS_PUBLIC_KEY ||
        !EMAILJS_PRIVATE_KEY
    ) {
        throw new Error("EmailJS OTP configuration is incomplete.");
    }

    if (
        typeof to !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) ||
        !/^\d{6}$/.test(String(otp))
    ) {
        throw new Error("Invalid OTP email information.");
    }

    const response = await emailjs.send(
        EMAILJS_SERVICE_ID,
        EMAILJS_OTP_TEMPLATE_ID,
        {
            to_email: to,
            otp: String(otp)
        },
        {
            publicKey: EMAILJS_PUBLIC_KEY,
            privateKey: EMAILJS_PRIVATE_KEY
        }
    );

    if (response?.status !== 200) {
        throw new Error("EmailJS did not accept the OTP email.");
    }

    return { sent: true };
}
async function sendElectionReportEmail({
    to,
    adviserName,
    electionTitle,
    schoolLevel,
    reportUrl
}) {
    const {
        EMAILJS_SERVICE_ID,
        EMAILJS_CONTACT_TEMPLATE_ID,
        EMAILJS_PUBLIC_KEY,
        EMAILJS_PRIVATE_KEY
    } = process.env;

    if (
        !EMAILJS_SERVICE_ID ||
        !EMAILJS_CONTACT_TEMPLATE_ID ||
        !EMAILJS_PUBLIC_KEY ||
        !EMAILJS_PRIVATE_KEY
    ) {
        throw new Error(
            "Election report EmailJS configuration is incomplete."
        );
    }

    if (
        !to ||
        !adviserName ||
        !electionTitle ||
        !reportUrl
    ) {
        throw new Error(
            "Missing election report email information."
        );
    }

    const subject =
        `Official Election Report - ${electionTitle}`;

    const message = [
        `Dear ${adviserName},`,
        "",
        "Greetings!",
        "",
        "The election report is available for review.",
        "",
        `Election: ${electionTitle}`,
        `School Level: ${schoolLevel}`,
        "",
        "Download your PDF report using this secure link:",
        reportUrl,
        "",
        "The link expires after 7 days.",
        "Please do not share this link with others.",
        "",
        "Thank you.",
        "",
        "CampusVote Administration"
    ].join("\n");

    const response = await emailjs.send(
        EMAILJS_SERVICE_ID,
        EMAILJS_CONTACT_TEMPLATE_ID,
        {
            to_email: to,
            to_name: adviserName,
            subject,
            message,
            report_url: reportUrl,
            election_title: electionTitle,
            school_level: schoolLevel
        },
        {
            publicKey: EMAILJS_PUBLIC_KEY,
            privateKey: EMAILJS_PRIVATE_KEY
        }
    );

    if (response?.status !== 200) {
        throw new Error(
            "EmailJS did not accept the election report email."
        );
    }

    return {
        sent: true,
        acceptedByProvider: true
    };
}

module.exports = {
    sendCredentialsEmail,
    sendPasswordResetOtpEmail,
    sendElectionReportEmail
};
