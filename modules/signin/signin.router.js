// signin.router.js
const express = require("express");
const router = express.Router();

const authentication = require("./signin.controller");
const verifyToken = require("../sheared/middleware");
const { requireAccess } = require("../sheared/middleware");
const passwordReset = require("./password-reset.controller");


router.post("/", authentication.login); // Login endpoint[cite: 2, 3]

// Protected endpoints
router.post("/logout", authentication.logout); // Clear cookie[cite: 2, 3]
router.get("/me", verifyToken, authentication.me); // Authenticated current user check[cite: 2, 3, 8]\
router.post("/first-password/change",verifyToken,authentication.changeFirstPassword);
router.post("/password-reset/request",passwordReset.requestReset);
router.post("/password-reset/verify",passwordReset.verifyReset);
router.post("/password-reset/confirm",passwordReset.confirmReset);


module.exports = router;