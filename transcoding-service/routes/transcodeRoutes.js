const express = require("express");
const router = express.Router();
const fileUpload = require("express-fileupload");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const axios = require('axios');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } = require("@aws-sdk/client-sqs");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const jwksClient = require("jwks-rsa");

// Configure AWS SDK clients
const s3Client = new S3Client({ region: "ap-southeast-2" });
const dynamoDBClient = new DynamoDBClient({ region: "ap-southeast-2" });
const ssmClient = new SSMClient({ region: "ap-southeast-2" });
const sqsClient = new SQSClient({ region: "ap-southeast-2" });
const qutUsername = "n11368853@qut.edu.au";
const SQS_QUEUE_URL = "https://sqs.ap-southeast-2.amazonaws.com/901444280953/n11368853-a3-queue";

// Add a health check endpoint
router.get("/transcode/health", (req, res) => {
  console.log("Health check endpoint hit");
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "transcoding-service"
  });
});

// Function to get parameters
async function getParameter(name) {
  const params = {
    Name: name,
    WithDecryption: true,
  };
  const command = new GetParameterCommand(params);
  const result = await ssmClient.send(command);
  return result.Parameter.Value;
}

// Retrieve parameters when the application starts
let videosTable;
let s3BucketName;

async function loadConfig() {
  try {
    console.log("Loading configuration parameters...");
    videosTable = await getParameter("/n11368853/aws/dynamodb/videosTable");
    s3BucketName = await getParameter("/n11368853/aws/s3/bucketName");
    console.log(`Loaded videos table name: ${videosTable}`);
    console.log(`Loaded S3 bucket name: ${s3BucketName}`);
  } catch (err) {
    console.error("Error loading configuration:", err);
    throw err;
  }
}

loadConfig()
  .then(() => {
    console.log("Configuration loaded successfully.");
  })
  .catch((err) => {
    console.error("Failed to load configuration on startup:", err);
  });

// Create a JWKS client to get Cognito's public key
const client = jwksClient({
  jwksUri: `https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_pkeyTLwPY/.well-known/jwks.json`,
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      console.error("Error getting signing key:", err);
      return callback(err);
    }
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

async function verifyToken(req, res, next) {
  const bearerHeader = req.headers["authorization"];
  console.log("Authorization header:", bearerHeader);
  if (bearerHeader) {
    const token = bearerHeader.split(" ")[1];
    jwt.verify(token, getKey, { algorithms: ["RS256"] }, async (err, authData) => {
      if (err) {
        console.error("JWT verification failed:", err);
        return res.sendStatus(403);
      }

      console.log("JWT verification succeeded, authData:", authData);

      try {
        const response = await axios.get(`https://n11368853-web.cab432.com/api/verify`, {
          headers: { Authorization: bearerHeader }
        });

        console.log("Auth service response status:", response.status);
        if (response.status === 200) {
          req.user = response.data;
          console.log("User verified successfully:", req.user);
          next();
        } else {
          console.error("Auth service returned status:", response.status);
          return res.sendStatus(403);
        }
      } catch (error) {
        console.error("Error contacting auth service:", error.message);
        return res.sendStatus(403);
      }
    });
  } else {
    console.error("Authorization header missing.");
    res.sendStatus(403);
  }
}

// SSE route for sending transcoding progress
let clients = new Map();

router.get("/transcode/progress/:filename", (req, res) => {
  const filename = req.params.filename;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "https://n11368853-web.cab432.com");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (!clients.has(filename)) {
    clients.set(filename, new Set());
  }
  clients.get(filename).add(res);
  console.log(`Client connected for SSE, watching file: ${filename}`);

  req.on("close", () => {
    console.log(`Client disconnected from SSE for file: ${filename}`);
    if (clients.has(filename)) {
      clients.get(filename).delete(res);
      if (clients.get(filename).size === 0) {
        clients.delete(filename);
      }
    }
  });
});

const sendProgress = (filename, message) => {
  if (clients.has(filename)) {
    clients.get(filename).forEach((client) => {
      client.write(`data: ${JSON.stringify(message)}\n\n`);
    });
  }
};
// Function to generate signed URL
async function generateSignedUrl(videoName) {
  const signedUrlParams = {
    Bucket: s3BucketName,
    Key: `transcoded/${videoName}-output.mp4`,
    Expires: 60 * 60,
    ResponseContentDisposition: `attachment; filename="${videoName}-output.mp4"`,
  };

  try {
    await s3Client.send(new HeadObjectCommand({ 
      Bucket: signedUrlParams.Bucket, 
      Key: signedUrlParams.Key 
    }));
    return await getSignedUrl(s3Client, new GetObjectCommand(signedUrlParams));
  } catch (err) {
    console.error("Error generating signed URL:", err);
    throw err;
  }
}

// Function to process a single transcoding job
async function processTranscodingJob(job) {
  const { s3Key, videoName, token } = job;
  console.log("Job details:", { s3Key, videoName, token });

  const tempDir = '/tmp';
  const inputFilePath = path.join(tempDir, `${videoName}-input.mov`);
  const outputFilePath = path.join(tempDir, `${videoName}-output.mp4`);
  const startTime = Date.now();

  try {
    // Download the file from S3
    console.log("Downloading from S3:", s3Key);
    const { Body } = await s3Client.send(new GetObjectCommand({
      Bucket: s3BucketName,
      Key: s3Key
    }));

    // Write the file to a temporary directory
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(inputFilePath);
      Body.pipe(writeStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    // Perform transcoding
    return new Promise((resolve, reject) => {
      ffmpeg(inputFilePath)
        .output(outputFilePath)
        .on("start", (commandLine) => {
          console.log("FFmpeg process started with command:", commandLine);
          sendProgress(videoName, { status: 'started', progress: 0 });
        })
        .on("progress", (progress) => {
          console.log(`Transcoding progress for ${videoName}: ${progress.percent}%`);
          sendProgress(videoName, { status: 'processing', progress: progress.percent });
        })
        .on("end", async () => {
          try {
            const endTime = Date.now();
            const transcodeDuration = ((endTime - startTime) / 1000).toFixed(2) + " seconds";

            // Upload the transcoded file to S3
            const s3Params = {
              Bucket: s3BucketName,
              Key: `transcoded/${videoName}-output.mp4`,
              Body: fs.createReadStream(outputFilePath),
              ContentType: "video/mp4",
            };

            await s3Client.send(new PutObjectCommand(s3Params));
            console.log(`File uploaded to S3: ${s3Params.Key}`);

            // Generate a download URL
            const downloadUrl = await generateSignedUrl(videoName);

            // Update DynamoDB
            const videoInfo = {
              TableName: videosTable,
              Item: {
                "qut-username": { S: qutUsername },
                videoName: { S: videoName },
                s3Url: { S: `https://${s3BucketName}.s3.amazonaws.com/transcoded/${videoName}-output.mp4` },
                transcodeDuration: { S: transcodeDuration },
                createdAt: { S: new Date().toISOString() },
              },
            };

            await dynamoDBClient.send(new PutItemCommand(videoInfo));

            // Clean up temporary files
            fs.unlinkSync(inputFilePath);
            fs.unlinkSync(outputFilePath);

            sendProgress(videoName, { 
              status: 'completed',
              progress: 100,
              downloadUrl: downloadUrl
            });

            resolve({
              status: 'success',
              message: 'Transcoding completed successfully',
              videoName: videoName,
              downloadUrl: downloadUrl
            });
          } catch (error) {
            // Clean up temporary files
            if (fs.existsSync(inputFilePath)) fs.unlinkSync(inputFilePath);
            if (fs.existsSync(outputFilePath)) fs.unlinkSync(outputFilePath);
            reject(error);
          }
        })
        .on("error", (err) => {
          console.error(`Error transcoding ${videoName}:`, err);
          // Clean up temporary files
          if (fs.existsSync(inputFilePath)) fs.unlinkSync(inputFilePath);
          if (fs.existsSync(outputFilePath)) fs.unlinkSync(outputFilePath);
          sendProgress(videoName, { 
            status: 'error', 
            error: err.message 
          });
          reject(err);
        })
        .run();
    });
  } catch (error) {
    // Clean up temporary files
    if (fs.existsSync(inputFilePath)) fs.unlinkSync(inputFilePath);
    if (fs.existsSync(outputFilePath)) fs.unlinkSync(outputFilePath);
    throw error;
  }
}

// Message processor service
async function startMessageProcessor() {
  console.log("Starting SQS message processor...");
  while (true) {
    try {
      const receiveCommand = new ReceiveMessageCommand({
        QueueUrl: SQS_QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: 900 // 15 minutes
      });

      const result = await sqsClient.send(receiveCommand);
      
      if (result.Messages && result.Messages.length > 0) {
        for (const message of result.Messages) {
          console.log("Processing new message from queue");
          try {
            const job = JSON.parse(message.Body);
            console.log(`Starting transcoding job for: ${job.videoName}`);
            
            await processTranscodingJob(job);

            // Delete processed messages
            const deleteCommand = new DeleteMessageCommand({
              QueueUrl: SQS_QUEUE_URL,
              ReceiptHandle: message.ReceiptHandle
            });
            await sqsClient.send(deleteCommand);
            console.log(`Successfully processed and deleted message for ${job.videoName}`);
          } catch (error) {
            console.error("Error processing message:", error);
          }
        }
      }
    } catch (error) {
      console.error("Error in message processor:", error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Start the message processor
startMessageProcessor().catch(error => {
  console.error("Message processor failed to start:", error);
});

// Modified transcode endpoint to use SQS
router.post("/transcode/normal", verifyToken, async (req, res) => {
  if (!req.files || !req.files.video) {
    return res.status(400).send("No files were uploaded.");
  }

  const videoFile = req.files.video;
  const videoName = path.parse(videoFile.name).name;

  try {
    // Directly upload to S3
    const s3Key = `uploads/${videoName}.mov`;
    const uploadParams = {
      Bucket: s3BucketName,
      Key: s3Key,
      Body: videoFile.data,
      ContentType: videoFile.mimetype
    };

    console.log("Uploading to S3 with params:", uploadParams);
    await s3Client.send(new PutObjectCommand(uploadParams));
    console.log("Successfully uploaded to S3");

    // Create SQS message
    const message = {
      s3Key,
      videoName,
      token: req.headers.authorization
    };

    console.log("Sending SQS message:", message);
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: SQS_QUEUE_URL,
      MessageBody: JSON.stringify(message)
    }));
    console.log("Successfully sent SQS message");

    res.json({
      status: "queued",
      message: "Your video has been queued for processing",
      videoName: videoName
    });

  } catch (err) {
    console.error("Error handling upload:", err);
    res.status(500).send("Failed to process video request");
  }
});

// Presigned URL endpoint
router.get("/presigned-url/:videoName", verifyToken, async (req, res) => {
  const videoName = req.params.videoName;
  try {
    const downloadUrl = await generateSignedUrl(videoName);
    res.json({ downloadUrl });
  } catch (err) {
    console.error("Error generating signed URL:", err);
    if (err.name === "NotFound") {
      return res.status(404).send("Video not found");
    }
    return res.status(500).send("Error generating signed URL");
  }
});

module.exports = router;