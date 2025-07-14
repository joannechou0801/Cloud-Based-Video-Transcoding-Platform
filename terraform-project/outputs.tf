# outputs.tf
output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.s3_distribution.domain_name
}

output "sqs_queue_url" {
  value = aws_sqs_queue.transcode_queue.url
}