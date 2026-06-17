/**
 * docker.ts - Docker development tools
 * 
 * Tools for docker build, docker compose, docker run
 */

import { Tool } from "../externalTools.js";

export const DOCKER_TOOLS: Tool[] = [
  // --- Docker Build -----------------------------------------------------
  {
    name: "docker_build",
    description: "Build Docker image",
    category: "docker",
    command: "docker",
    args: ["build"],
    flags: [
      { name: "-t", type: "string", required: true, description: "Image tag" },
      { name: "-f", type: "string", description: "Dockerfile path" },
      { name: "--build-arg", type: "string", description: "Build arguments" },
      { name: "--no-cache", type: "boolean", description: "Don't use cache" }
    ],
    detection: {
      method: "binary",
      check: "docker --version"
    },
    context: {
      whenToUse: [
        "build docker image",
        "docker build",
        "build container"
      ],
      requiresProject: ["Dockerfile"],
      examples: ["docker build -t myapp .", "docker build -t myapp -f Dockerfile.prod ."]
    },
    outputParser: "raw"
  },
  
  // --- Docker Run -------------------------------------------------------
  {
    name: "docker_run",
    description: "Run Docker container",
    category: "docker",
    command: "docker",
    args: ["run"],
    flags: [
      { name: "-d", type: "boolean", description: "Run in detached mode" },
      { name: "--name", type: "string", description: "Container name" },
      { name: "-p", type: "string", description: "Port mapping" },
      { name: "-v", type: "string", description: "Volume mapping" },
      { name: "--rm", type: "boolean", description: "Remove container on exit" },
      { name: "-e", type: "string", description: "Environment variables" }
    ],
    detection: {
      method: "binary",
      check: "docker --version"
    },
    context: {
      whenToUse: [
        "run docker container",
        "docker run",
        "start container"
      ],
      examples: ["docker run -d -p 8080:80 --name myapp myapp", "docker run --rm myapp"]
    },
    outputParser: "raw"
  },
  
  // --- Docker Compose ---------------------------------------------------
  {
    name: "docker_compose_up",
    description: "Start Docker Compose services",
    category: "docker",
    command: "docker",
    args: ["compose", "up"],
    flags: [
      { name: "-d", type: "boolean", description: "Run in detached mode" },
      { name: "--build", type: "boolean", description: "Build before starting" },
      { name: "--force-recreate", type: "boolean", description: "Force recreate" },
      { name: "services", type: "string", description: "Specific services" }
    ],
    detection: {
      method: "binary",
      check: "docker --version"
    },
    context: {
      whenToUse: [
        "start docker compose",
        "docker compose up",
        "start services"
      ],
      requiresProject: ["docker-compose.yml"],
      examples: ["docker compose up -d", "docker compose up --build", "docker compose up -d db api"]
    },
    outputParser: "raw"
  },
  
  {
    name: "docker_compose_down",
    description: "Stop Docker Compose services",
    category: "docker",
    command: "docker",
    args: ["compose", "down"],
    flags: [
      { name: "--volumes", type: "boolean", description: "Remove volumes" },
      { name: "--rmi", type: "string", description: "Remove images" }
    ],
    detection: {
      method: "binary",
      check: "docker --version"
    },
    context: {
      whenToUse: [
        "stop docker compose",
        "docker compose down",
        "stop services"
      ],
      requiresProject: ["docker-compose.yml"],
      examples: ["docker compose down", "docker compose down --volumes"]
    },
    outputParser: "raw"
  },
  
  // --- Docker PS --------------------------------------------------------
  {
    name: "docker_ps",
    description: "List Docker containers",
    category: "docker",
    command: "docker",
    args: ["ps"],
    flags: [
      { name: "-a", type: "boolean", description: "Show all containers" },
      { name: "--format", type: "string", description: "Output format" }
    ],
    detection: {
      method: "binary",
      check: "docker --version"
    },
    context: {
      whenToUse: [
        "list docker containers",
        "docker ps",
        "show containers"
      ],
      examples: ["docker ps", "docker ps -a"]
    },
    outputParser: "raw"
  },
  
  // --- Docker Logs ------------------------------------------------------
  {
    name: "docker_logs",
    description: "View Docker container logs",
    category: "docker",
    command: "docker",
    args: ["logs"],
    flags: [
      { name: "container", type: "string", required: true, description: "Container name/ID" },
      { name: "-f", type: "boolean", description: "Follow logs" },
      { name: "--tail", type: "string", description: "Number of lines" }
    ],
    detection: {
      method: "binary",
      check: "docker --version"
    },
    context: {
      whenToUse: [
        "view docker logs",
        "docker logs",
        "check container logs"
      ],
      examples: ["docker logs myapp", "docker logs -f myapp", "docker logs --tail 100 myapp"]
    },
    outputParser: "raw"
  },
  
  // --- Docker Exec ------------------------------------------------------
  {
    name: "docker_exec",
    description: "Execute command in Docker container",
    category: "docker",
    command: "docker",
    args: ["exec"],
    flags: [
      { name: "-it", type: "boolean", description: "Interactive mode" },
      { name: "container", type: "string", required: true, description: "Container name/ID" },
      { name: "command", type: "string", required: true, description: "Command to execute" }
    ],
    detection: {
      method: "binary",
      check: "docker --version"
    },
    context: {
      whenToUse: [
        "execute in container",
        "docker exec",
        "run command in container"
      ],
      examples: ["docker exec -it myapp bash", "docker exec myapp ls"]
    },
    outputParser: "raw"
  },
  
  // --- Docker Image -----------------------------------------------------
  {
    name: "docker_images",
    description: "List Docker images",
    category: "docker",
    command: "docker",
    args: ["images"],
    flags: [
      { name: "-a", type: "boolean", description: "Show all images" }
    ],
    detection: {
      method: "binary",
      check: "docker --version"
    },
    context: {
      whenToUse: [
        "list docker images",
        "docker images"
      ],
      examples: ["docker images", "docker images -a"]
    },
    outputParser: "raw"
  },
  
  // --- Docker Pull ------------------------------------------------------
  {
    name: "docker_pull",
    description: "Pull Docker image",
    category: "docker",
    command: "docker",
    args: ["pull"],
    flags: [
      { name: "image", type: "string", required: true, description: "Image name" }
    ],
    detection: {
      method: "binary",
      check: "docker --version"
    },
    context: {
      whenToUse: [
        "pull docker image",
        "docker pull",
        "download image"
      ],
      examples: ["docker pull nginx", "docker pull postgres:14"]
    },
    outputParser: "raw"
  },
  
  // --- Docker Push ------------------------------------------------------
  {
    name: "docker_push",
    description: "Push Docker image to registry",
    category: "docker",
    command: "docker",
    args: ["push"],
    flags: [
      { name: "image", type: "string", required: true, description: "Image name" }
    ],
    detection: {
      method: "binary",
      check: "docker --version"
    },
    context: {
      whenToUse: [
        "push docker image",
        "docker push",
        "upload image"
      ],
      examples: ["docker push myregistry/myapp:latest"]
    },
    outputParser: "raw"
  },
  
  // --- Docker System ----------------------------------------------------
  {
    name: "docker_prune",
    description: "Clean up Docker resources",
    category: "docker",
    command: "docker",
    args: ["system", "prune"],
    flags: [
      { name: "-a", type: "boolean", description: "Remove all unused images" },
      { name: "--volumes", type: "boolean", description: "Remove volumes" },
      { name: "-f", type: "boolean", description: "Force prune" }
    ],
    detection: {
      method: "binary",
      check: "docker --version"
    },
    context: {
      whenToUse: [
        "clean docker",
        "docker prune",
        "cleanup containers"
      ],
      examples: ["docker system prune", "docker system prune -a --volumes"]
    },
    outputParser: "raw"
  }
];