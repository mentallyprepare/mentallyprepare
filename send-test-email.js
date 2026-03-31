const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const msg = {
  to: 'YOUR_EMAIL@example.com', // Change to your recipient
  from: 'YOUR_VERIFIED_SENDGRID_EMAIL@example.com', // Change to your verified sender
  subject: 'Test Email from SendGrid',
  text: 'This is a test email sent using SendGrid and Node.js!',
};

sgMail
  .send(msg)
  .then(() => {
    console.log('Email sent');
  })
  .catch((error) => {
    console.error(error);
  });
