const multer = require("multer");
const path = require("path");
const fs = require("fs");

const evidenceDirectory = path.join(
  __dirname,
  "../../assessment-evidence"
);

fs.mkdirSync(evidenceDirectory, {
  recursive: true,
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, evidenceDirectory);
  },

  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();

    const uniqueName =
      `${req.user.sub}-${Date.now()}${extension}`;

    cb(null, uniqueName);
  },
});

const uploadAssessmentEvidence = multer({
  storage,

  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },

  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      "image/png",
      "image/jpeg",
      "application/pdf",
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      return cb(
        new Error(
          "Only PNG, JPG, JPEG, and PDF evidence files are allowed."
        )
      );
    }

    cb(null, true);
  },
});

module.exports = uploadAssessmentEvidence;
