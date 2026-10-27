
"use strict";

const express = require("express");
const router = express.Router();

const controller = require("../ballotReceiving/ballotReceiving.controller");
const verifyToken = require("../../sheared/middleware");

router.use(
    verifyToken,
    verifyToken.requireRole(
        "super_admin",
        "committee"
    )
);

router.post("/receive", controller.receiveBallot);

module.exports = router;
