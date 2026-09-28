const express = require("express");
const repo = require("../data");
const { authRequired, roleRequired } = require("../middleware/auth");

const router = express.Router();

/**
 * @openapi
 * /api/certificate-validation/{certificateCode}:
 *   get:
 *     tags: [Certificates]
 *     summary: Validate a certificate by its certificate code
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: certificateCode
 *         required: true
 *         description: Certificate code printed on the user's certificate
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Certificate code matched and the certificate is valid
 *         content:
 *           application/json:
 *             example:
 *               valid: true
 *               message: Certificate verified successfully.
 *               certificate:
 *                 id: 7f7c1c2e-7e6c-4d4e-a5ce-3b6e2d4f5a6b
 *                 certificate_code: EDU-A1B2C3D4
 *                 issued_date: 2026-09-05T10:00:00.000Z
 *                 student: { id: 1, name: Jane Doe, email: jane@example.com }
 *                 course: { id: 2, title: JavaScript Basics, provider: EDU-SAAS }
 *       401:
 *         description: Authentication is required
 *       403:
 *         description: Only employers and admins can validate certificates
 *       400:
 *         description: Certificate code is missing
 *       404:
 *         description: Certificate code did not match any certificate
 *         content:
 *           application/json:
 *             example:
 *               valid: false
 *               message: Certificate code is invalid.
 *               certificate: null
 */
router.get(
	"/:certificateCode",
	authRequired,
	roleRequired("employer", "admin"),
	async (req, res, next) => {
	try {
		const certificateCode = String(req.params.certificateCode || "").trim();

		if (!certificateCode) {
			return res.status(400).json({
				valid: false,
				message: "Certificate code is required.",
				error: "Certificate code is required.",
			});
		}

		const certificate = await repo.certificates.findByCode(certificateCode);

		if (!certificate) {
			return res.status(404).json({
				valid: false,
				message: "Certificate code is invalid.",
				certificate: null,
				error: "Certificate not found.",
			});
		}

		return res.json({
			valid: true,
			message: "Certificate verified successfully.",
			certificate: {
				id: certificate.id,
				certificate_code: certificate.certificate_code,
				issued_date: certificate.issued_date,
				student: certificate.user.name,
				course: certificate.course.title,
			},
		});
	} catch (err) {
		next(err);
	}
	}
);

module.exports = router;
