const express = require("express");
const router = express.Router();
const adminController = require("./admin.controller");
const verifyToken = require("../../sheared/middleware");

// Every route below requires a valid token AND an admin role
router.use(verifyToken, verifyToken.isAdmin);

// Create account 
router.post("/accounts", adminController.createAccount);
// update 
router.put("/accounts/:id",adminController.updateAccount);
// List accounts
router.get("/accounts", adminController.getAccounts);

// Delete account 
router.delete("/accounts/:id", adminController.deleteAccount);
module.exports = router;