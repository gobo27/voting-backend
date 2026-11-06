
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


module.exports = {
    sendCredentialsEmail,
    sendPasswordResetOtpEmail
};
