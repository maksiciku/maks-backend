const SibApiV3Sdk = require("sib-api-v3-sdk");

const client = SibApiV3Sdk.ApiClient.instance;

client.authentications["api-key"].apiKey =
  process.env.BREVO_API_KEY;

const api = new SibApiV3Sdk.TransactionalEmailsApi();

async function sendWelcomeEmail({
  email,
  restaurantName,
}) {
  return api.sendTransacEmail({
    sender: {
      email: "support@maksos.co.uk",
      name: "MAKS OS",
    },

    to: [
      {
        email,
      },
    ],

    subject: "Welcome to MAKS OS",

    htmlContent: `
  <div style="background:#eef6fb;padding:32px;font-family:Arial,sans-serif;color:#061f2f;">
    <div style="max-width:620px;margin:auto;background:white;border-radius:22px;padding:34px;box-shadow:0 18px 50px rgba(0,0,0,0.08);">
      
      <div style="text-align:center;margin-bottom:24px;">
<img
  src="https://maksos.co.uk/maks-logo-tab.PNG"
  alt="MAKS OS"
  style="max-width:220px;height:auto;margin-bottom:14px;"
/>
        <h1 style="margin:0;font-size:30px;color:#005b73;">Welcome to MAKS OS</h1>
      </div>

      <p style="font-size:17px;line-height:1.6;">
        Your restaurant account has been created successfully.
      </p>

      <div style="background:#eef6fb;border-radius:16px;padding:18px;margin:22px 0;">
        <strong style="font-size:20px;color:#005b73;">${restaurantName}</strong>
      </div>

      <p style="font-size:16px;line-height:1.6;">
        You can now log in and start setting up your POS, tables, bookings, stock and kitchen display.
      </p>

      <div style="text-align:center;margin:30px 0;">
        <a href="https://maksos.co.uk/login"
           style="background:#00aeea;color:white;text-decoration:none;padding:14px 26px;border-radius:14px;font-weight:800;display:inline-block;">
          Open MAKS OS
        </a>
      </div>

      <p style="font-size:14px;color:#5d7180;">
        Need help? Reply to this email or contact support@maksos.co.uk
      </p>

      <hr style="border:none;border-top:1px solid #e5eef3;margin:26px 0;" />

      <p style="font-size:12px;color:#7b8b95;text-align:center;">
        MAKS OS — One core. Every restaurant operation.
      </p>
    </div>
  </div>
`,
  });
}

async function sendPasswordResetEmail({ email, resetUrl }) {
  return api.sendTransacEmail({
    sender: {
      email: "support@maksos.co.uk",
      name: "MAKS OS Support",
    },
    to: [{ email }],
    subject: "Reset your MAKS OS password",
    htmlContent: `
      <div style="background:#eef6fb;padding:32px;font-family:Arial,sans-serif;color:#061f2f;">
        <div style="max-width:620px;margin:auto;background:white;border-radius:22px;padding:34px;">
          <div style="text-align:center;margin-bottom:24px;">
            <img src="https://maksos.co.uk/logo192.png" alt="MAKS OS" style="width:72px;height:auto;margin-bottom:14px;" />
            <h1 style="margin:0;font-size:28px;color:#005b73;">Reset your password</h1>
          </div>

          <p style="font-size:16px;line-height:1.6;">
            We received a request to reset your MAKS OS password.
          </p>

          <div style="text-align:center;margin:30px 0;">
            <a href="${resetUrl}"
              style="background:#00aeea;color:white;text-decoration:none;padding:14px 26px;border-radius:14px;font-weight:800;display:inline-block;">
              Reset Password
            </a>
          </div>

          <p style="font-size:14px;color:#5d7180;">
            This link expires in 15 minutes. If you did not request this, ignore this email.
          </p>

          <hr style="border:none;border-top:1px solid #e5eef3;margin:26px 0;" />

          <p style="font-size:12px;color:#7b8b95;text-align:center;">
            MAKS OS — One core. Every restaurant operation.
          </p>
        </div>
      </div>
    `,
  });
}

async function sendBookingConfirmationEmail({
  email,
  restaurantName,
  customerName,
  bookingTime,
  guests,
  reference,
  manageUrl,
  status = "confirmed",

}) {
  return api.sendTransacEmail({
    sender: {
      email: "bookings@maksos.co.uk",
      name: `${restaurantName} via MAKS OS`,
    },

    to: [{ email }],

subject:
  status === "confirmed"
    ? `Booking confirmed - ${restaurantName}`
    : `Booking request received - ${restaurantName}`,

    htmlContent: `
      <div style="background:#eef6fb;padding:32px;font-family:Arial,sans-serif;color:#061f2f;">
        <div style="max-width:620px;margin:auto;background:white;border-radius:22px;padding:34px;box-shadow:0 18px 50px rgba(0,0,0,0.08);">
          
          <div style="text-align:center;margin-bottom:24px;">

  <img
    src="https://maksos.co.uk/maks-logo-tab.PNG"
    alt="MAKS OS"
    style="
      width:72px;
      height:72px;
      object-fit:contain;
      margin-bottom:16px;
      border-radius:18px;
    "
  />

  <h1
    style="
      margin:0;
      font-size:30px;
      color:#005b73;
      font-weight:900;
    "
  >
    ${restaurantName}
  </h1>

  <p
    style="
      margin:8px 0 0;
      color:#5d7180;
      font-size:15px;
    "
  >
${
  status === "confirmed"
    ? "Booking confirmed"
    : "Booking request received"
}  </p>

</div>

          <p style="font-size:17px;line-height:1.6;">
            Hi ${customerName},
          </p>

          <p style="font-size:16px;line-height:1.6;">
${
  status === "confirmed"
    ? `Your booking has been confirmed by ${restaurantName}.`
    : `Your booking request has been received by ${restaurantName}.`
}          </p>

          <div style="background:#eef6fb;border-radius:16px;padding:18px;margin:22px 0;">
            <p><strong>Reference:</strong> #${reference}</p>
            <p><strong>Date/time:</strong> ${new Date(bookingTime).toLocaleString("en-GB")}</p>
            <p><strong>Guests:</strong> ${guests}</p>
          </div>

          <div style="text-align:center;margin:30px 0;">
            <a href="${manageUrl}"
               style="background:#00aeea;color:white;text-decoration:none;padding:14px 26px;border-radius:14px;font-weight:800;display:inline-block;">
              Manage Booking
            </a>
          </div>

          <p style="font-size:14px;color:#5d7180;">
            If you did not make this booking, you can ignore this email or use the manage link above.
          </p>

          <hr style="border:none;border-top:1px solid #e5eef3;margin:26px 0;" />

          <p style="font-size:12px;color:#7b8b95;text-align:center;">
            Powered by MAKS OS
          </p>
        </div>
      </div>
    `,
  });
}
async function sendBookingStatusEmail({
  email,
  restaurantName,
  customerName,
  bookingTime,
  guests,
  reference,
  status,
  manageUrl,
}) {
  const statusText =
    status === "confirmed"
      ? "confirmed"
      : status === "declined"
        ? "declined"
        : "updated";

  return api.sendTransacEmail({
    sender: {
      email: "bookings@maksos.co.uk",
      name: `${restaurantName} via MAKS OS`,
    },
    to: [{ email }],
    subject: `Your booking has been ${statusText} - ${restaurantName}`,
    htmlContent: `
      <div style="background:#eef6fb;padding:32px;font-family:Arial,sans-serif;color:#061f2f;">
        <div style="max-width:620px;margin:auto;background:white;border-radius:22px;padding:34px;box-shadow:0 18px 50px rgba(0,0,0,0.08);">
          <div style="text-align:center;margin-bottom:24px;">
            <img src="https://maksos.co.uk/maks-logo-tab.PNG" alt="MAKS OS" style="width:72px;height:72px;object-fit:contain;margin-bottom:16px;border-radius:18px;" />
            <h1 style="margin:0;font-size:30px;color:#005b73;">${restaurantName}</h1>
            <p style="margin:8px 0 0;color:#5d7180;">Booking ${statusText}</p>
          </div>

          <p style="font-size:17px;line-height:1.6;">Hi ${customerName},</p>

          <p style="font-size:16px;line-height:1.6;">
            Your booking at <strong>${restaurantName}</strong> has been <strong>${statusText}</strong>.
          </p>

          <div style="background:#eef6fb;border-radius:16px;padding:18px;margin:22px 0;">
            <p><strong>Reference:</strong> #${reference}</p>
            <p><strong>Date/time:</strong> ${new Date(bookingTime).toLocaleString("en-GB")}</p>
            <p><strong>Guests:</strong> ${guests}</p>
          </div>

          <div style="text-align:center;margin:30px 0;">
            <a href="${manageUrl}"
               style="background:#00aeea;color:white;text-decoration:none;padding:14px 26px;border-radius:14px;font-weight:800;display:inline-block;">
              Manage Booking
            </a>
          </div>

          <hr style="border:none;border-top:1px solid #e5eef3;margin:26px 0;" />

          <p style="font-size:12px;color:#7b8b95;text-align:center;">
            Powered by MAKS OS
          </p>
        </div>
      </div>
    `,
  });
}

async function sendBookingChangeRequestEmail({
  restaurantEmail,
  restaurantName,
  customerName,
  requestedBookingTime,
  requestedGuests,
  requestedNote,
  bookingId,
}) {
  return api.sendTransacEmail({
    sender: {
      email: "bookings@maksos.co.uk",
      name: "MAKS OS Bookings",
    },
    to: [{ email: restaurantEmail }],
    subject: `Booking change request - ${restaurantName}`,
    htmlContent: `
      <div style="background:#eef6fb;padding:32px;font-family:Arial,sans-serif;color:#061f2f;">
        <div style="max-width:620px;margin:auto;background:white;border-radius:22px;padding:34px;">
          <h1 style="margin:0 0 12px;color:#005b73;">Booking change request</h1>

          <p><strong>${customerName}</strong> has requested a change.</p>

          <div style="background:#eef6fb;border-radius:16px;padding:18px;margin:22px 0;">
            <p><strong>Booking ref:</strong> #${bookingId}</p>
            ${
              requestedBookingTime
                ? `<p><strong>Requested time:</strong> ${new Date(requestedBookingTime).toLocaleString("en-GB")}</p>`
                : ""
            }
            ${
              requestedGuests
                ? `<p><strong>Requested guests:</strong> ${requestedGuests}</p>`
                : ""
            }
            ${
              requestedNote
                ? `<p><strong>Note:</strong> ${requestedNote}</p>`
                : ""
            }
          </div>

          <div style="text-align:center;margin:30px 0;">
            <a href="https://maksos.co.uk/bookings"
               style="background:#00aeea;color:white;text-decoration:none;padding:14px 26px;border-radius:14px;font-weight:800;display:inline-block;">
              Open Bookings
            </a>
          </div>

          <p style="font-size:12px;color:#7b8b95;text-align:center;">
            Powered by MAKS OS
          </p>
        </div>
      </div>
    `,
  });
}

module.exports = {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendBookingConfirmationEmail,
  sendBookingStatusEmail,
  sendBookingChangeRequestEmail,
};