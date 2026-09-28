const multer = require("multer")
const path = require("path")

const MINI_PROJECT_MAX_FILE_SIZE = Number(process.env.MINI_PROJECT_MAX_FILE_SIZE )
    if (
        !Number.isInteger(MINI_PROJECT_MAX_FILE_SIZE) ||
        MINI_PROJECT_MAX_FILE_SIZE <= 0
    ) {
        throw new Error(
            "MINI_PROJECT_MAX_FILE_SIZE must be a positive integer."
        )
    }

const uploadMiniProject = multer({
    storage: multer.memoryStorage(),

    limits: {
        fileSize: MINI_PROJECT_MAX_FILE_SIZE,
        files: 1,
    },

    fileFilter: (req, file, cb) => {
        const extension = path.extname(file.originalname || "").toLowerCase();

        if(extension != ".zip"){
            const error = new Error("Only ZIP files are allowed.")
            error.code = "INVALID_FILE_TYPE"
            return cb(error)
        }

        cb(null, true)
    },
})

module.exports = uploadMiniProject