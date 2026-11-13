
"use strict";

const express = require("express");
const router = express.Router();

const adminController = require("./admin.controller");
const assignmentController = require("./admin.assignments.controller");
const verifyToken = require("../../sheared/middleware");

// Super Admin lang ang may access
router.use(verifyToken, verifyToken.isAdmin);

// Existing account endpoints
router.post("/accounts", adminController.createAccount);
router.get("/accounts", adminController.getAccounts);
router.put("/accounts/:id", adminController.updateAccount);
router.delete("/accounts/:id", adminController.deleteAccount);
router.get(
    "/scopes",
    assignmentController.getScopes
);

// Committeea assignments
router.get(
    "/accounts/:id/assignments",
    assignmentController.getAssignments
);

// Save/revoke multiple Committee assignments
router.put(
    "/accounts/:id/assignments",
    assignmentController.updateAssignments
);

module.exports = router;
