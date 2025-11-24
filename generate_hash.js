const bcrypt = require('bcryptjs');

const password = 'Pkboss@12';
// Hashing the password with 10 salt rounds
const saltRounds = 10;

bcrypt.hash(password, saltRounds, function(err, hash) {
    if (err) {
        console.error("Hashing Error:", err);
    } else {
        console.log("--- USE THIS STRING AS YOUR ADMIN_PASSWORD_HASH ---");
        console.log(hash);
        console.log("---------------------------------------------------");
    }
});