
"use strict";

const emailjs = require("@emailjs/nodejs");

// Ipadala ang account credentials gamit ang EmailJS
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

    // Dapat tugma sa EmailJS template variables
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

module.exports = {
    sendCredentialsEmail
};
