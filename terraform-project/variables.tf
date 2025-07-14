# variables.tf
variable "project_prefix" {
  description = "Prefix for all resources"
  default     = "n11368853"
}

variable "instance_type" {
  description = "EC2 instance type"
  default     = "t2.micro"
}