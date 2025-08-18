const jwt = require("jsonwebtoken");
const SECRET_KEY = "your_secret_key"; // Replace with process.env.SECRET_KEY if using env variables

// ✅ Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
    const token = req.headers["authorization"]?.split(" ")[1];
    if (!token) return res.status(401).send("Access denied.");

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).send("Invalid token.");
        req.user = user;
        next();
    });
};

// ✅ Middleware to check user roles
const checkRoles = (roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).send("Forbidden: Insufficient permissions");
        }
        next();
    };
};

module.exports = { authenticateToken, checkRoles };
