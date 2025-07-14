# Cloud-Based Video Transcoding Platform

## Project Overview

This project is a cloud-based video transcoding platform consisting of two main microservices:

* **Auth Service**: Provides user authentication and management using AWS Cognito.
* **Transcoding Service**: Handles user video uploads, performs transcoding using FFmpeg, and stores the results on AWS S3.

Additionally, the project leverages AWS services (EC2, ALB, S3, SQS, DynamoDB, CloudFront) for the overall architecture and uses Terraform for Infrastructure as Code.

---

## System Architecture

```plaintext
Client (Frontend Application)
    ↓ HTTPS Requests
AWS Application Load Balancer (ALB)
    ├─ /api/auth* → Auth Service (EC2)
    └─ /api/transcode* → Transcoding Service (EC2 + ASG)
    
Transcoding Service
    ├─ Receives video uploads to S3
    ├─ Pushes transcoding jobs to SQS queue
    ├─ Consumes messages from SQS and performs transcoding (FFmpeg)
    ├─ Uploads transcoded files back to S3
    └─ Reports transcoding progress to frontend via SSE

Other AWS Services:
- DynamoDB: Stores video transcoding metadata and records
- CloudFront: Caches and accelerates static assets
```

---

## Key Features

### Auth Service

* Implements user registration, login, and token verification with AWS Cognito
* Supports JWT token verification and dynamic retrieval of Cognito public keys
* Provides REST APIs for registration, login, token validation, user info, and user list

### Transcoding Service

* Receives video uploads via REST API, with a 50MB file size limit
* Uploads videos to AWS S3 and pushes transcoding jobs to AWS SQS
* Consumes SQS messages and transcodes videos from `.mov` to `.mp4` using FFmpeg
* Uploads transcoded results back to S3 and generates pre-signed URLs for download
* Pushes transcoding progress updates to frontend via Server-Sent Events (SSE)
* Stores video metadata and transcoding records in DynamoDB

### Infrastructure (Terraform)

* Deploys EC2 instances running Auth and Transcoding services
* Uses Application Load Balancer as the frontend entry point with path-based routing
* Creates an Auto Scaling Group for scalable transcoding service
* Creates an SQS queue for managing transcoding jobs
* Creates an S3 bucket for storing static files and transcoded videos
* Uses CloudFront for accelerating static content delivery

---

## Deployment Instructions

### Prerequisites

* AWS account with appropriate IAM permissions
* Node.js environment (version 14+ recommended)
* Terraform CLI installed

### 1. Deploy Infrastructure

1. Edit `terraform-project/variables.tf` to customize project prefix, EC2 instance types, etc.
2. Run the following commands in the `terraform-project` directory:

```bash
terraform init
terraform apply
```

3. After deployment, Terraform will output the ALB DNS, CloudFront domain, and SQS queue URL.

### 2. Configure Environment Variables

* For Auth Service `.env`:

```
TRANSCODING_SERVICE_URL=https://my-alb-domain/api/transcode
```

* For Transcoding Service `.env`:

```
AUTH_SERVICE_URL=https://my-alb-domain/api/auth
```

### 3. Start Services

Navigate to both `auth-service` and `transcoding-service` directories and run:

```bash
npm install
npm start
```

Services will listen on default ports (3001 and 3002), with traffic routed via ALB.

---

## API Summary

* `POST /api/auth/register`: User registration
* `POST /api/auth/login`: User login, returns JWT token
* `GET /api/auth/verify`: Token verification
* `POST /api/transcode/normal`: Upload video and enqueue transcoding job
* `GET /api/transcode/progress/:filename`: Get transcoding progress via SSE
* `GET /api/transcode/presigned-url/:videoName`: Get download link for transcoded video

---

## Environment Variables Description

| Variable Name             | Description                                       |
| ------------------------- | ------------------------------------------------- |
| TRANSCODING\_SERVICE\_URL | URL used by Auth Service to call Transcoding APIs |
| AUTH\_SERVICE\_URL        | URL used by Transcoding Service to call Auth APIs |

---

## Technologies and Tools

* Node.js (Express)
* AWS Cognito, S3, SQS, DynamoDB, EC2, ALB, CloudFront
* Terraform Infrastructure as Code
* FFmpeg video transcoding
* JWT and JWKS verification
* Server-Sent Events (SSE) for real-time notifications

---

## Notes

* Ensure AWS Parameter Store is configured with the necessary Cognito User Pool, Client ID, DynamoDB tables, and S3 bucket names.
* Adjust AWS resource naming and permissions as needed.
* Video files are limited to 50MB and supported format conversion is `.mov` to `.mp4`.
* Verify ALB HTTPS setup and certificate validity.
