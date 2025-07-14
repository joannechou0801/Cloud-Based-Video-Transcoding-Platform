# main.tf

# Security Group
resource "aws_security_group" "cab432_sg" {
  id = "sg-032bd1ff8cf77dbb9"  # 使用現有的安全組 ID
}

# EC2 Instances
resource "aws_instance" "auth_service" {
  ami           = "ami-0892a9c01908fafd1"
  instance_type = var.instance_type
  subnet_id     = "subnet-075811427d5564cf9"
  vpc_security_group_ids = [aws_security_group.cab432_sg.id]

  tags = {
    Name = "${var.project_prefix}-first"
  }
}

resource "aws_instance" "transcoding_service" {
  ami           = "ami-0892a9c01908fafd1"
  instance_type = var.instance_type
  subnet_id     = "subnet-075811427d5564cf9"
  vpc_security_group_ids = [aws_security_group.cab432_sg.id]

  tags = {
    Name = "${var.project_prefix}-second"
  }
}

# Launch Template for Auto Scaling
resource "aws_launch_template" "transcoding_template" {
  name_prefix   = "${var.project_prefix}-transcoding-template"
  instance_type = var.instance_type
  image_id      = "ami-0892a9c01908fafd1"  # Corrected here

  user_data = <<-EOT
    #!/bin/bash
    # 用於啟動 EC2 實例的初始化腳本
    # 這裡可以添加 Node.js 等應用的啟動命令
  EOT

  network_interfaces {
    associate_public_ip_address = true
    security_groups = [aws_security_group.cab432_sg.id]
  }

  tags = {
    Name = "${var.project_prefix}-transcoding-instance"
  }
}

# Auto Scaling Group
resource "aws_autoscaling_group" "transcoding_asg" {
  desired_capacity     = 1
  max_size             = 3
  min_size             = 1
  vpc_zone_identifier  = ["subnet-075811427d5564cf9"]  # 您的子網ID
  launch_template {
    id      = aws_launch_template.transcoding_template.id
    version = "$Latest"
  }

  health_check_type          = "EC2"
  health_check_grace_period = 300
  load_balancers            = [aws_lb.main.id]
  target_group_arns         = [aws_lb_target_group.transcoding_service.arn]

  tag {
    key                 = "Name"
    value               = "${var.project_prefix}-transcoding-instance"
    propagate_at_launch = true
  }
}

# SQS Queue
resource "aws_sqs_queue" "transcode_queue" {
  name                      = "${var.project_prefix}-a3-queue"
  delay_seconds             = 0
  max_message_size         = 262144  # 256 KB
  message_retention_seconds = 345600  # 4 days
  visibility_timeout_seconds = 30
  receive_wait_time_seconds = 0

  tags = {
    Name = "${var.project_prefix}-a3-queue"
  }
}

# ALB Target Groups
resource "aws_lb_target_group" "auth_service" {
  id = "arn:aws:elasticloadbalancing:ap-southeast-2:901444280953:targetgroup/n11368853-auth-service-tg/e01f427fd50dd1cb"  # 使用現有的目標組 ARN
}

resource "aws_lb_target_group" "transcoding_service" {
  id = "arn:aws:elasticloadbalancing:ap-southeast-2:901444280953:targetgroup/n11368853-transcoding-service-tg/1703ef251e55237a"  # 使用現有的目標組 ARN
}

# ALB
resource "aws_lb" "main" {
  name               = "${var.project_prefix}-alb4"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.cab432_sg.id]
  subnets           = ["subnet-075811427d5564cf9"]  # 可以添加更多子網

  tags = {
    Name = "${var.project_prefix}-alb4"
  }
}

# ALB Listener
resource "aws_lb_listener" "front_end" {
  load_balancer_arn = aws_lb.main.arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-2016-08"
  certificate_arn   = "arn:aws:acm:ap-southeast-2:901444280953:certificate/d72c83cc-14bb-4d35-a596-f7e7ec586e04"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.auth_service.arn
  }
}

# ALB Listener Rules
resource "aws_lb_listener_rule" "auth_service" {
  listener_arn = aws_lb_listener.front_end.arn
  priority     = 1

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.auth_service.arn
  }

  condition {
    path_pattern {
      values = ["/api/auth*"]
    }
  }
}

resource "aws_lb_listener_rule" "transcoding_service" {
  listener_arn = aws_lb_listener.front_end.arn
  priority     = 2

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.transcoding_service.arn
  }

  condition {
    path_pattern {
      values = ["/api/transcode*"]
    }
  }
}

# S3 Bucket
resource "aws_s3_bucket" "main" {
  bucket = "${var.project_prefix}-assignment2"
}

resource "aws_s3_bucket_public_access_block" "main" {
  bucket = aws_s3_bucket.main.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "main" {
  bucket = aws_s3_bucket.main.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadGetObject"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.main.arn}/static/*"
      }
    ]
  })
}

# CloudFront Distribution
resource "aws_cloudfront_distribution" "s3_distribution" {
  enabled = true
  
  origin {
    domain_name = "${aws_s3_bucket.main.bucket_regional_domain_name}"
    origin_id   = "S3-${aws_s3_bucket.main.id}"
    origin_path = "/static"
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${aws_s3_bucket.main.id}"
    
    viewer_protocol_policy = "redirect-to-https"
    
    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Name = "${var.project_prefix}-cloudfront"
  }
}
