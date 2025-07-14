# Cloud-Based Video Transcoding Platform

## 專案介紹

本專案是一個基於雲端的影片轉碼平台，包含兩個主要微服務：

* **Auth Service**：使用 AWS Cognito 提供用戶身份認證與管理功能。
* **Transcoding Service**：負責接收用戶影片，使用 FFmpeg 進行轉碼，並將結果上傳至 AWS S3 儲存。

此外，本專案使用 AWS 相關服務（EC2、ALB、S3、SQS、DynamoDB、CloudFront）進行整體架構搭建，並以 Terraform 實現基礎設施即程式碼（Infrastructure as Code）。

---

## 系統架構

```plaintext
Client (前端應用)
    ↓ HTTPS 請求
AWS Application Load Balancer (ALB)
    ├─ /api/auth* → Auth Service (EC2)
    └─ /api/transcode* → Transcoding Service (EC2 + ASG)
    
Transcoding Service
    ├─ 接收影片檔上傳至 S3
    ├─ 將轉碼工作推送至 SQS 隊列
    ├─ 從 SQS 消費訊息進行轉碼 (FFmpeg)
    ├─ 將轉碼後檔案上傳 S3
    └─ 透過 SSE 向前端回報轉碼進度

AWS 其他服務：
- DynamoDB：紀錄影片轉碼紀錄與元資料
- CloudFront：用於靜態資源快取與加速
```

---

## 主要功能說明

### Auth Service

* 使用 AWS Cognito 實現用戶註冊、登入、Token 驗證
* 支援 JWT Token 驗證並整合 Cognito 公鑰動態取得
* 提供 REST API：註冊、登入、驗證 Token、查詢用戶資訊、使用者列表等

### Transcoding Service

* 透過 REST API 接收影片檔案上傳，限制 50MB
* 影片檔案先上傳至 AWS S3，並推送轉碼任務至 AWS SQS
* 消費 SQS 訊息並使用 FFmpeg 進行影片轉碼（.mov → .mp4）
* 轉碼結果上傳至 S3，並產生預簽名 URL 供下載
* 透過 Server-Sent Events (SSE) 向前端推送轉碼進度更新
* 利用 DynamoDB 紀錄轉碼影片相關資料

### 基礎設施（Terraform）

* 部署 EC2 實例執行 Auth 與 Transcoding 服務
* 使用 Application Load Balancer 作為前端入口，並設置路徑路由
* 建立 Auto Scaling Group 動態擴展轉碼服務
* 建立 SQS 隊列處理轉碼工作排程
* 建立 S3 Bucket 存放靜態檔案與轉碼結果
* 使用 CloudFront 加速靜態資源存取

---

## 專案部署說明

### 環境需求

* AWS 帳戶，並設定好相關 IAM 權限
* Node.js 環境 (版本 14+ 推薦)
* Terraform CLI

### 1. 部署基礎設施

1. 編輯 `terraform-project/variables.tf` 可自訂專案前綴、EC2 規格等
2. 在 `terraform-project` 目錄執行：

```bash
terraform init
terraform apply
```

3. 部署完成後，Terraform 將輸出 ALB DNS、CloudFront 網域與 SQS 隊列 URL 等資訊。

### 2. 設定環境變數

* Auth Service `.env`：

```
TRANSCODING_SERVICE_URL=https://我的ALB域名/api/transcode
```

* Transcoding Service `.env`：

```
AUTH_SERVICE_URL=https://我的ALB域名/api/auth
```

### 3. 服務啟動

分別進入 `auth-service` 與 `transcoding-service` 目錄，執行：

```bash
npm install
npm start
```

服務將監聽預設端口（3001 與 3002），由 ALB 轉發流量。

---

## API 介面概要

* `POST /api/auth/register`：用戶註冊
* `POST /api/auth/login`：用戶登入，回傳 JWT Token
* `GET /api/auth/verify`：Token 驗證
* `POST /api/transcode/normal`：影片上傳並排入轉碼
* `GET /api/transcode/progress/:filename`：取得轉碼進度（SSE）
* `GET /api/transcode/presigned-url/:videoName`：取得轉碼後影片下載連結

---

## 環境變數說明

| 變數名稱                      | 功能說明                                          |
| ------------------------- | --------------------------------------------- |
| TRANSCODING\_SERVICE\_URL | Auth Service 用於呼叫 Transcoding Service API 的網址 |
| AUTH\_SERVICE\_URL        | Transcoding Service 用於呼叫 Auth Service API 的網址 |

---

## 技術與工具

* Node.js (Express)
* AWS Cognito, S3, SQS, DynamoDB, EC2, ALB, CloudFront
* Terraform Infrastructure as Code
* FFmpeg 影片轉碼
* JWT 與 JWKS 驗證
* Server-Sent Events (SSE) 實時通知

---

## 注意事項

* 部署過程需確保 AWS Parameter Store 內設定有對應的 Cognito User Pool、Client ID 及 DynamoDB 表、S3 Bucket 名稱等參數。
* AWS 資源命名與權限設定請依實際需求調整。
* 影片檔案大小限制在 50MB 以內，且支援 .mov 轉 .mp4。
* 請確認 ALB 的 HTTPS 設定及證書有效性。

