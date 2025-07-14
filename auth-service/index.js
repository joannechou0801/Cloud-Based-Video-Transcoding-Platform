const express = require('express');
const fileUpload = require('express-fileupload');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Import routes
const authRoutes = require('./routes/authRoutes');

// Middleware for parsing JSON requests
app.use(express.json());

// Middleware for enabling CORS
app.use(cors({
    origin: 'https://n11368853-web.cab432.com',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Add proxy header handling
app.use((req, res, next) => {
    res.setHeader('X-Forwarded-Proto', 'https');
    if (req.headers['x-forwarded-for']) {
        req.realIp = req.headers['x-forwarded-for'].split(',')[0];
    }
    next();
});

app.use('/api', authRoutes);
app.use(express.static(path.join(__dirname, 'public')));
app.use(fileUpload());

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ message: 'Something went wrong!' });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Auth Service running on port ${PORT}`);
});