const nodemailer = require("nodemailer");
const { smtpUser, smtpPass, smtpFrom } = require("./env");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
});

const sendOtpEmail = async (email, otp) => {
  try {
    console.log("[mail debug] sending OTP to", email);
    console.log("[mail debug] SMTP_USER set:", !!process.env.SMTP_USER);

    const formattedOtp = `${otp.slice(0, 3)} ${otp.slice(3)}`;

    await transporter.sendMail({
      from: smtpFrom,
      to: email,
      subject: "Password Reset OTP",

      text: `
        Your password reset verification code is:

        ${otp}

        This OTP is valid for 10 minutes.

        If you did not request a password reset, please ignore this email.

        - Vayvora EduTech
              `,

              html: `
        <div style="margin:0;padding:40px 0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

        <table
          align="center"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
          style="max-width:520px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,.05);">

          <!-- Header -->
          <tr>
            <td
              align="center"
              style="background:#0284c7;padding:28px;">

              <div
                style="font-size:24px;font-weight:700;color:#ffffff;">
                Vayvora EduTech
              </div>

              <div
                style="font-size:13px;color:#dbeafe;margin-top:6px;">
                Secure Account Verification
              </div>

            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px;">

              <h2
                style="margin:0 0 16px;color:#0f172a;font-size:24px;">
                Reset Your Password
              </h2>

              <p
                style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.7;">
                We received a request to reset the password for your
                <strong>Vayvora EduTech</strong> account.
                Use the verification code below to continue.
              </p>

              <!-- OTP BOX -->
              <table
                width="100%"
                cellpadding="0"
                cellspacing="0"
                border="0"
                style="margin-bottom:28px;">

                <tr>
                  <td
                    align="center"
                    style="
                      background:#f0f9ff;
                      border:2px dashed #0284c7;
                      border-radius:8px;
                      padding:18px;">

                    <div
                      style="
                        font-size:36px;
                        font-weight:800;
                        letter-spacing:8px;
                        color:#0369a1;
                        font-family:'Courier New',monospace;">

                      ${formattedOtp}

                    </div>

                  </td>
                </tr>

              </table>

              <!-- Expiry -->
              <table
                width="100%"
                cellpadding="0"
                cellspacing="0"
                border="0">

                <tr>
                  <td
                    style="
                      border-top:1px solid #e2e8f0;
                      padding-top:24px;">

                    <p
                      style="
                        margin:0 0 12px;
                        color:#475569;
                        font-size:14px;
                        line-height:1.6;">

                      ⏱️
                      This verification code is valid for
                      <strong>10 minutes</strong>.

                    </p>

                    <p
                      style="
                        margin:0;
                        color:#64748b;
                        font-size:13px;
                        line-height:1.7;">

                      <strong>Security Tip:</strong>
                      Never share this OTP with anyone.
                      Vayvora EduTech employees will never ask
                      for your verification code.

                    </p>

                  </td>
                </tr>

              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>

            <td
              align="center"
              style="
                padding:24px;
                background:#f8fafc;
                border-top:1px solid #e2e8f0;">

              <p
                style="
                  margin:0;
                  color:#94a3b8;
                  font-size:12px;
                  line-height:1.6;">

                This is an automated email.
                Please do not reply directly to this message.

              </p>

              <p
                style="
                  margin:8px 0 0;
                  color:#94a3b8;
                  font-size:12px;">

                © 2026 Vayvora EduTech.
                All rights reserved.

              </p>

            </td>

          </tr>

        </table>

        </div>
              `,
    });
  } catch (err) {
    console.error(
      "[mail error] sendOtpEmail failed:",
      err && err.stack ? err.stack : err
    );
    throw err;
  }
};
const sendEmail = async ({
  to,
  subject,
  text,
  html,
}) => {
  try {
    console.log("[mail] sending email to", to);

    const result = await transporter.sendMail({
      from: smtpFrom,
      to,
      subject,
      text,
      html,
    });

    console.log("[mail] email sent:", result.messageId);

    return result;
  } catch (err) {
    console.error(
      "[mail error] sendEmail failed:",
      err && err.stack ? err.stack : err
    );
    throw err;
  }
};

module.exports = {
  transporter,
  sendOtpEmail,
  sendEmail
};
