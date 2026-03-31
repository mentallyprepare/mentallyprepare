const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const msg = {
  to: 'mymentallyprepare.com@mymentallyprepare.com', // Use your verified sender as recipient for test
  from: 'mymentallyprepare.com@mymentallyprepare.com', // Verified sender email
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
