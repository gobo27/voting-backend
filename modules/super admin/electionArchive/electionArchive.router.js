"use strict";

const express = require("express");
const router = express.Router();

const verifyToken = require("../../../modules/sheared/middleware");
const controller = require("./electionArchive.controller");

// SUPER ADMIN ONLY
router.use(
    verifyToken,
    verifyToken.requireRole("super_admin")
);

// ELECTION HISTORY
router.get("/", controller.list);

// VIEW RESULTS, BALLOTS AND CANDIDATES
router.get("/:id/details", controller.details);

// ARCHIVE ELECTION
router.post("/:id/archive", controller.archive);

// CREATE NEW ELECTION
router.post("/", controller.create);

module.exports = router;