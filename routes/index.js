
const express = require("express");
const router = express.Router();

// Import routes
const signinRoutes = require("../modules/signin/signin.router");
const adminRoutes = require("../modules/super admin/adduser/admin.router");
const candidateRoutes = require("../modules/adviser/addCandidate/adviser.addCandidate.router");
const positionRoutes = require("../modules/adviser/position/addPosition.router");
const electionControlRoutes = require("../modules/adviser/controller/electionControl.router");
const ballotRoutes = require("../modules/Committee/creatingballot/creatingballot.router");
const ballotQRRoutes = require("../modules/Committee/ballotQR/ballotQR.router");
const omrRoutes = require("../modules/Committee/OMR/omr.router");
const ballotReceivingRoutes = require("../modules/Committee/ballotReceiving/ballotReceiving.router");
const dashboardRoutes = require("../modules/dashboard/dashboard.router");
const electionArchiveRoutes = require("../modules/super admin/electionArchive/electionArchive.router");

// API routes
router.use("/signin", signinRoutes);
router.use("/createAccount", adminRoutes);
router.use("/candidates", candidateRoutes);
router.use("/positions", positionRoutes);
router.use("/election", electionControlRoutes);
router.use("/ballots", ballotRoutes);
router.use("/ballots/qr", ballotQRRoutes);
router.use("/omr", omrRoutes);
router.use("/ballots",ballotReceivingRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/election_archive", electionArchiveRoutes);

module.exports = router;
