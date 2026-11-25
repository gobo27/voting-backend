
"use strict";

const express = require("express");
const router = express.Router();

const adminController = require("./admin.controller");
const assignmentController = require("./admin.assignments.controller");
const verifyToken = require("../../sheared/middleware");

// Super Admin only
router.use(verifyToken, verifyToken.isAdmin);

// ACCOUNT MANAGEMENT
router.post("/accounts", adminController.createAccount);
router.get("/accounts", adminController.getAccounts);
router.put("/accounts/:id", adminController.updateAccount);
router.delete("/accounts/:id", adminController.deleteAccount);

// AVAILABLE ELECTION SCOPES
router.get(
    "/scopes",
    assignmentController.getScopes
);

// COMMITTEE ASSIGNMENTS
router.get(
    "/accounts/:id/assignments",
    assignmentController.getAssignments
);

router.put(
    "/accounts/:id/assignments",
    assignmentController.updateAssignments
);

// ADVISER ASSIGNMENT
router.put(
    "/accounts/:id/adviser-assignment",
    assignmentController.assignAdviser
);

module.exports = router;
