const path = require("path");
const fs = require("fs");
const multer = require("multer");

const avatarDirectory = path.join(
  __dirname,
  "../../uploads/avatars"
);

fs.mkdirSync(avatarDirectory, {
  recursive: true,
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, avatarDirectory);
  },
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const uniqueName = `avatar-${req.user.sub}-${Date.now()}${extension}`;
    cb(null, uniqueName);
  },
});

const uploadAvatar = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    const extension = path.extname(file.originalname).toLowerCase();

    if (!allowedExtensions.includes(extension)) {
      return cb(
        new Error("Only image files (.jpg, .jpeg, .png, .webp, .gif) are allowed.")
      );
    }

    cb(null, true);
  },
});

module.exports = uploadAvatar;
