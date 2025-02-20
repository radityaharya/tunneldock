import { default as Cloudflare } from "cloudflare";
import { TunnelConfig } from "../types";
import { logger } from "../utils/logger";

export class CloudflareService {
  private cloudflare: Cloudflare;
  private accountId: string;
  private zoneId: string;
  private domain: string;

  constructor() {
    this.cloudflare = new Cloudflare({
      apiEmail: process.env.CF_API_EMAIL || "",
      apiToken: process.env.CF_API_TOKEN || "",
    });
    this.accountId = process.env.CF_ACCOUNT_ID || "";
    this.zoneId = process.env.CF_ZONE_ID || "";
    this.domain = "";
  }

  async initialize(): Promise<void> {
    try {
      logger.info("Starting Cloudflare service initialization...");

      logger.debug("Validating account credentials...");
      // Validate credentials
      const account = await this.cloudflare.accounts.get({
        account_id: this.accountId,
      });
      if (!account) {
        throw new Error("Invalid Cloudflare account credentials");
      }
      logger.debug("Account credentials validated successfully");

      // Get zone details
      logger.debug("Fetching zone details...");
      const zone = await this.cloudflare.zones.get({
        zone_id: this.zoneId,
      });
      if (!zone) {
        throw new Error("Invalid zone ID");
      }
      this.domain = zone.name;
      logger.debug(
        { zoneName: zone.name },
        "Zone details fetched successfully"
      );

      // Verify tunnel exists
      logger.debug("Verifying tunnel...");
      const tunnel = await this.cloudflare.zeroTrust.tunnels.get(
        process.env.CF_TUNNEL_ID || "",
        { account_id: this.accountId }
      );
      if (!tunnel) {
        throw new Error("Invalid tunnel ID");
      }
      logger.debug("Tunnel verified successfully");

      logger.info(
        {
          account: account.name,
          zone: zone.name,
          tunnel: tunnel.name,
        },
        "Cloudflare service initialized successfully"
      );
    } catch (error: any) {
      logger.error({ err: error }, "Failed to initialize Cloudflare service");
      throw new Error(`Cloudflare initialization failed: ${error.message}`);
    }
  }

  getDomain(): string {
    return this.domain;
  }

  async manageDNSRecord(hostname: string, tunnelId: string): Promise<string> {
    try {
      logger.info({ hostname }, `Managing DNS record`);
      const subdomain = hostname.split(".")[0];
      const target = `${tunnelId}.cfargotunnel.com`;

      const records = await this.cloudflare.dns.records.list({
        zone_id: this.zoneId,
        name: {
          exact: hostname,
        },
        type: "CNAME",
      });

      let status = "";
      if (records.result && records.result.length > 0) {
        const existingRecord = records.result[0];
        if (existingRecord.content !== target) {
          logger.info({ hostname, target }, `Updating existing record`);
          await this.cloudflare.dns.records.update(existingRecord.id, {
            zone_id: this.zoneId,
            content: target,
            name: subdomain,
            type: "CNAME",
            proxied: true,
          });
          status = "updated";
          logger.info({ hostname }, `Successfully updated DNS record`);
        } else {
          status = "unchanged";
          logger.info(
            { hostname },
            `No changes needed, record already correct`
          );
        }
      } else {
        logger.info({ hostname, target }, `Creating new record`);
        await this.cloudflare.dns.records.create({
          zone_id: this.zoneId,
          content: target,
          name: subdomain,
          type: "CNAME",
          proxied: true,
        });
        status = "created";
        logger.info({ hostname }, `Successfully created DNS record`);
      }

      return status;
    } catch (error) {
      logger.error({ err: error, hostname }, `Error managing DNS record`);
      throw error;
    }
  }

  async updateTunnelConfig(
    tunnelId: string,
    config: TunnelConfig
  ): Promise<void> {
    try {
      logger.info({ tunnelId, config }, `Updating tunnel configuration`);

      const currentConfig =
        await this.cloudflare.zeroTrust.tunnels.configurations.get(tunnelId, {
          account_id: this.accountId,
        });

      const defaultOriginRequest = {
        connectTimeout: 0,
        disableChunkedEncoding: false,
        http2Origin: false,
        noTLSVerify: false,
        tcpKeepAlive: 30,
      };

      // Get current ingress rules or initialize with default catch-all
      let ingressRules = currentConfig.config?.ingress || [
        { service: "http_status:404", hostname: "*" },
      ];

      // Find if there's an existing rule for this hostname
      const existingRuleIndex = ingressRules.findIndex(
        (rule) => rule.hostname === config.hostname
      );

      const newRule = {
        hostname: config.hostname,
        service: config.service,
        originRequest: {
          ...defaultOriginRequest,
          ...config.originRequest,
        },
      };

      if (existingRuleIndex !== -1) {
        // Update existing rule
        ingressRules[existingRuleIndex] = newRule;
      } else {
        // Add new rule before the catch-all rule
        ingressRules.splice(ingressRules.length - 1, 0, newRule);
      }

      const tunnelConfig = {
        account_id: this.accountId,
        config: {
          ingress: ingressRules,
        },
      };

      logger.debug(
        { tunnelConfig },
        "Sending tunnel configuration to Cloudflare"
      );

      await this.cloudflare.zeroTrust.tunnels.configurations.update(
        tunnelId,
        tunnelConfig
      );

      logger.info(
        { tunnelId, hostname: config.hostname },
        `Successfully updated tunnel configuration`
      );
    } catch (error) {
      logger.error(
        { err: error, tunnelId, config },
        `Error updating tunnel configuration`
      );
      throw error;
    }
  }

  async deleteTunnelConfig(hostname: string, tunnelId: string): Promise<void> {
    try {
      logger.info({ hostname, tunnelId }, "Deleting tunnel configuration");

      // First, find and remove the DNS record
      const records = await this.cloudflare.dns.records.list({
        zone_id: this.zoneId,
        name: {
          exact: hostname,
        },
        type: "CNAME",
      });
      console.log(records);
      if (records.result && records.result.length > 0) {
        const record = records.result[0];
        await this.cloudflare.dns.records.delete(record.id, {
          zone_id: this.zoneId,
        });
        logger.debug({ hostname }, "DNS record deleted");
      } else {
        logger.debug({ hostname }, "No DNS record found to delete");
      }

      // Then remove the tunnel ingress configuration
      const currentConfig =
        await this.cloudflare.zeroTrust.tunnels.configurations.get(tunnelId, {
          account_id: this.accountId,
        });

      let ingressRules = currentConfig.config?.ingress || [];

      // Filter out the rule for this hostname
      ingressRules = ingressRules.filter((rule) => rule.hostname !== hostname);

      // Make sure we still have the catch-all rule
      if (!ingressRules.find((rule) => rule.hostname === "*")) {
        ingressRules.push({ service: "http_status:404", hostname: "*" });
      }

      const tunnelConfig = {
        account_id: this.accountId,
        config: {
          ingress: ingressRules,
        },
      };

      await this.cloudflare.zeroTrust.tunnels.configurations.update(
        tunnelId,
        tunnelConfig
      );

      logger.info(
        { hostname, tunnelId },
        "Successfully deleted tunnel configuration and DNS record"
      );
    } catch (error) {
      logger.error(
        { err: error, hostname, tunnelId },
        "Error deleting tunnel configuration"
      );
      throw error;
    }
  }
}
