const express = require("express");
const router = express.Router();
const { CognitoIdentityProviderClient, AdminGetUserCommand, ListUsersCommand, AdminCreateUserCommand, AdminSetUserPasswordCommand, AdminAddUserToGroupCommand, InitiateAuthCommand, AdminListGroupsForUserCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const axios = require("axios");
const { GetUserCommand } = require("@aws-sdk/client-cognito-identity-provider");

// Add health check endpoint
router.get("/auth/health", (req, res) => {
  console.log("Health check endpoint hit");
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "auth-service"
  });
});

// Configure AWS SDK clients
const cognito = new CognitoIdentityProviderClient({ region: "ap-southeast-2" });
const ssm = new SSMClient({ region: "ap-southeast-2" });

// Function to get parameters
async function getParameter(name) {
  const command = new GetParameterCommand({
    Name: name,
    WithDecryption: true,
  });
  const result = await ssm.send(command);
  return result.Parameter.Value;
}

let userPoolId;
let clientId;
let client;

async function loadConfig() {
  userPoolId = await getParameter("/n11368853/aws/cognito/userPoolId");
  clientId = await getParameter("/n11368853/aws/cognito/clientId");

  client = jwksClient({
    jwksUri: `https://cognito-idp.ap-southeast-2.amazonaws.com/${userPoolId}/.well-known/jwks.json`,
  });
}

loadConfig()
  .then(() => {
    console.log("Configuration loaded successfully.");
  })
  .catch((err) => {
    console.error("Error loading configuration:", err);
  });

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      console.error("Error retrieving signing key:", err);
      return callback(err);
    }
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

async function verifyToken(req, res, next) {
  const bearerHeader = req.headers["authorization"];
  if (bearerHeader) {
    const token = bearerHeader.split(" ")[1];
    jwt.verify(token, await getKey, { algorithms: ["RS256"] }, (err, authData) => {
      if (err) {
        console.error("Token verification failed:", err);
        return res.sendStatus(403);
      }
      req.user = authData;
      console.log("Authenticated user:", req.user);
      next();
    });
  } else {
    console.error("No token provided");
    res.sendStatus(403);
  }
}

const qutUsername = "n11368853@qut.edu.au";

// Verify route
router.get("/verify", verifyToken, (req, res) => {
  console.log("Verify route hit");
  res.json({ message: "Token is valid", user: req.user });
});

// Check user login status
router.get("/user", verifyToken, async (req, res) => {
  try {
    const username = req.user["cognito:username"];
    if (!username) {
      return res.status(400).send("Username is required");
    }
    const params = {
      UserPoolId: userPoolId,
      Username: username,
    };

    const userData = await cognito.send(new GetUserCommand({
      AccessToken: req.headers["authorization"].split(" ")[1],
    }));
    const userGroup = userData.UserAttributes.find(
      (attr) => attr.Name === "cognito:groups"
    ) || { Value: "User" };

    res.json({ username, group: userGroup.Value });
  } catch (error) {
    console.error("Error fetching user data:", error);
    res.status(500).send("Failed to fetch user data");
  }
});

// User list route
router.get("/users", verifyToken, async (req, res) => {
  try {
    const params = {
      UserPoolId: userPoolId,
      Limit: 60,
    };

    const usersData = await cognito.send(new ListUsersCommand(params));
    const users = usersData.Users.map((user) => ({
      username: user.Username,
      email: user.Attributes.find((attr) => attr.Name === "email")?.Value,
    }));

    res.json(users);
  } catch (error) {
    console.error("Error fetching user list:", error);
    res.status(500).send("Failed to fetch user list");
  }
});

// Registration route
router.post("/register", async (req, res) => {
  const { username, password } = req.body;

  try {
    const existingUsers = await cognito.send(new ListUsersCommand({
      UserPoolId: userPoolId,
      Filter: `username = "${username}"`,
    }));

    if (existingUsers.Users.length > 0) {
      return res.status(400).send("Username already exists");
    }

    const cognitoParams = {
      UserPoolId: userPoolId,
      Username: username,
      UserAttributes: [
        { Name: "email", Value: `${username}@example.com` },
        { Name: "email_verified", Value: "true" },
      ],
    };

    await cognito.send(new AdminCreateUserCommand(cognitoParams));

    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: username,
      Password: password,
      Permanent: true,
    }));

    await cognito.send(new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: username,
      GroupName: "User",
    }));

    res.status(201).send("User registered successfully");
  } catch (error) {
    console.error("Error registering user:", error);
    res.status(500).send("User registration failed");
  }
});

// Login route
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const cognitoParams = {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: clientId,
    AuthParameters: {
      USERNAME: username,
      PASSWORD: password,
    },
  };

  try {
    const authResult = await cognito.send(new InitiateAuthCommand(cognitoParams));
    const token = authResult.AuthenticationResult.IdToken;

    // Get user groups
    const userGroups = await cognito.send(new AdminListGroupsForUserCommand({
      Username: username,
      UserPoolId: userPoolId,
    }));

    res.json({
      token,
      group: userGroups.Groups.map((group) => group.GroupName),
    });
  } catch (error) {
    console.error("Error logging in with Cognito:", error);
    if (
      error.name === "NotAuthorizedException" &&
      error.message.includes("NEW_PASSWORD_REQUIRED")
    ) {
      const challengeResponse = {
        ChallengeName: error.message,
        Session: error.session,
        UserIdForSRP: error.challengeParameters.USER_ID_FOR_SRP,
      };
      return res.status(400).json(challengeResponse);
    }
    res.status(401).send("Invalid credentials");
  }
});

// Add transcoding route
router.post("/transcode", verifyToken, async (req, res) => {
  const videoData = req.body;
  try {
    const transcodingServiceUrl = process.env.TRANSCODING_SERVICE_URL;
    const response = await axios.post(transcodingServiceUrl, videoData, {
      headers: {
        'Authorization': req.headers.authorization
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error("Error calling transcoding service:", error);
    res.status(500).send("Transcoding failed");
  }
});

module.exports = router;