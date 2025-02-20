import { DockerService } from "./services/docker";
import { CloudflareService } from "./services/cloudflare";
import { DataService } from "./services/data";
import { CustomContainerInfo } from "./types";
import { logger } from "./utils/logger";

class TunnelDock {
  private dockerService!: DockerService;
  private cloudflareService: CloudflareService;
  private dataService: DataService;
  private tunnelId: string;
  private watchInterval: number;

  constructor() {
    this.validateEnvironment();
    this.cloudflareService = new CloudflareService();
    this.dataService = new DataService();
    this.tunnelId = process.env.CF_TUNNEL_ID || "";
    this.watchInterval = parseInt(
      process.env.TUNNELDOCK_WATCH_INTERVAL || "1000"
    );
  }

  private validateEnvironment(): void {
    const requiredEnvVars = [
      "CF_API_TOKEN",
      "CF_API_EMAIL",
      "CF_ACCOUNT_ID",
      "CF_TUNNEL_ID",
      "CF_ZONE_ID",
    ];

    const missingVars = requiredEnvVars.filter(
      (varName) => !process.env[varName]
    );
    if (missingVars.length > 0) {
      logger.error({ missingVars }, "Missing required environment variables");
      process.exit(1);
    }

    // Log optional configurations
    logger.info(
      {
        watchInterval: this.watchInterval,
      },
      "Optional configurations loaded"
    );
  }

  async syncContainer(
    container: CustomContainerInfo,
    previousState?: string
  ): Promise<void> {
    const { shouldManage, config } =
      await this.dockerService.shouldManageTunnel(container, previousState);

    if (shouldManage && config) {
      logger.info(
        { containerName: config.containerName, state: container.State, config },
        `Container state change detected`
      );

      try {
        // First update tunnel config
        await this.cloudflareService.updateTunnelConfig(this.tunnelId, {
          hostname: config.hostname,
          service: config.service,
          originRequest: config.originRequest,
        });

        // Update tunnel data with config status
        this.dataService.updateTunnelData(config.hostname, {
          hostname: config.hostname,
          tunnelId: this.tunnelId,
          service: config.service,
          configStatus: "updated",
        });

        // Then handle DNS
        const dnsStatus = await this.cloudflareService.manageDNSRecord(
          config.hostname,
          this.tunnelId
        );

        // Update tunnel data again with DNS status
        this.dataService.updateTunnelData(config.hostname, {
          hostname: config.hostname,
          tunnelId: this.tunnelId,
          service: config.service,
          configStatus: "updated",
          dnsStatus: dnsStatus,
        });

        logger.info({ hostname: config.hostname }, `Configuration completed`);
      } catch (error) {
        logger.error(
          { err: error, hostname: config.hostname },
          `Error configuring tunnel`
        );
      }
    }
  }

  private async cleanupStaleRecords(
    containers: CustomContainerInfo[]
  ): Promise<void> {
    const currentData = this.dataService.loadData();
    const activeHostnames = new Set<string>();

    // Collect active hostnames from running containers
    for (const container of containers) {
      const { config } = await this.dockerService.shouldManageTunnel(container);
      if (config) {
        activeHostnames.add(config.hostname);
      }
    }

    // Find and remove stale tunnels and domains
    const staleHostnames = Object.keys(currentData.tunnels).filter(
      (hostname) => !activeHostnames.has(hostname)
    );

    for (const hostname of staleHostnames) {
      logger.info(
        { hostname },
        "Cleaning up stale tunnel configuration and records"
      );

      try {
        await this.cloudflareService.deleteTunnelConfig(
          hostname,
          this.tunnelId
        );

        // Remove local records
        delete currentData.tunnels[hostname];
        if (currentData.domains[hostname]) {
          delete currentData.domains[hostname];
        }

        logger.info(
          { hostname },
          "Successfully cleaned up tunnel configuration and records"
        );
      } catch (error) {
        logger.error(
          { err: error, hostname },
          "Error cleaning up tunnel configuration"
        );
      }
    }

    if (staleHostnames.length > 0) {
      this.dataService.saveData({
        ...currentData,
        timestamp: new Date().toISOString(),
      });
      logger.info({ staleHostnames }, "Cleaned up stale records");
    }
  }

  async watchContainers(): Promise<void> {
    let previousContainers: CustomContainerInfo[] = [];

    try {
      logger.info(
        { watchInterval: this.watchInterval },
        "Starting container and tunnel monitoring"
      );

      while (true) {
        const containers = await this.dockerService.getContainerInfo();
        const currentData = this.dataService.loadData();

        // Update stored container data while preserving tunnels and domains
        this.dataService.saveData({
          timestamp: new Date().toISOString(),
          containers,
          tunnels: currentData.tunnels || {},
          domains: currentData.domains || {},
        });

        // Process each container
        for (const container of containers) {
          const previousContainer = previousContainers.find(
            (prev) => prev.Names[0] === container.Names[0]
          );
          await this.syncContainer(container, previousContainer?.State);
        }

        // Clean up stale records
        await this.cleanupStaleRecords(containers);

        previousContainers = containers;
        await new Promise((resolve) => setTimeout(resolve, this.watchInterval));
      }
    } catch (error) {
      logger.error({ err: error }, "Error in monitoring loop");
    }
  }

  async initialize(): Promise<void> {
    try {
      logger.info("Initializing TunnelDock...");
      await this.cloudflareService.initialize();
      // Initialize DockerService with domain after CloudflareService is initialized
      this.dockerService = new DockerService(
        this.cloudflareService.getDomain()
      );
      logger.info("TunnelDock initialization complete");
    } catch (error) {
      logger.error({ err: error }, "Failed to initialize TunnelDock");
      throw error;
    }
  }
}

// Start the application
const tunnelDock = new TunnelDock();
tunnelDock
  .initialize()
  .then(() => tunnelDock.watchContainers())
  .catch((error) => {
    logger.error({ err: error }, "Failed to start TunnelDock");
    process.exit(1);
  });
