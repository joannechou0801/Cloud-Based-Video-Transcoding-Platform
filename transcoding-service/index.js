const express = require('express');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3002;


// CORS configuration
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

// Import routes
const transcodeRoutes = require('./routes/transcodeRoutes');

// Middleware
app.use(express.json());
app.use(fileUpload({
    createParentPath: true,
    limits: { fileSize: 50 * 1024 * 1024 } // Limit the file size to 50MB
}));

app.use('/api', transcodeRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ message: 'Something went wrong!' });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Transcoding Service running on port ${PORT}`);
});