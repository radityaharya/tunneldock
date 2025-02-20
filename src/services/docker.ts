import Docker from "dockerode";
import { 
  CustomContainerInfo, 
  DockerLabelConfig, 
  DockerTunnelConfig,
  dockerLabelConfigSchema,
  dockerTunnelConfigSchema,
  TunnelOriginRequest
} from "../schemas";
import { logger } from "../utils/logger";

export class DockerService {
  private docker: Docker;
  private domain: string;

  // Type-safe parser configuration
  private static originRequestParsers: Record<keyof TunnelOriginRequest, (value: string) => any> = {
    http2Origin: (value) => value.toLowerCase() === 'true',
    noTLSVerify: (value) => value.toLowerCase() === 'true',
    disableChunkedEncoding: (value) => value.toLowerCase() === 'true',
    noHappyEyeballs: (value) => value.toLowerCase() === 'true',
    connectTimeout: (value) => parseInt(value),
    keepAliveConnections: (value) => parseInt(value),
    keepAliveTimeout: (value) => parseInt(value),
    tcpKeepAlive: (value) => parseInt(value),
    tlsTimeout: (value) => parseInt(value),
    httpHostHeader: (value) => value,
    originServerName: (value) => value,
    proxyType: (value) => value
  };

  constructor(domain: string) {
    this.docker = new Docker();
    this.domain = domain;
  }

  async getContainerInfo(): Promise<CustomContainerInfo[]> {
    const containers = await this.docker.listContainers({ all: true });
    return containers.map((container) => ({
      ...container,
      created: new Date(container.Created * 1000).toISOString(),
    }));
  }

  private parseDotNotationLabels(labels: Record<string, string>): DockerLabelConfig {
    const config: DockerLabelConfig = {
      originRequest: {}  // Initialize with empty object to avoid undefined
    };

    for (const [key, value] of Object.entries(labels)) {
      if (!key.startsWith('tunneldock.')) continue;

      const path = key.split('.');
      if (path.length < 2) continue;

      switch (path[1]) {
        case 'hostname':
          config.hostname = value;
          break;
        case 'assign':
          config.assign = value.toLowerCase() === 'true';
          break;
        case 'service':
          if (!config.service) config.service = { protocol: 'http' };
          if (path.length < 3) continue;
          
          switch (path[2]) {
            case 'protocol':
              config.service.protocol = value;
              break;
            case 'port':
              config.service.port = parseInt(value);
              break;
            case 'path':
              config.service.path = value;
              break;
          }
          break;
        case 'originRequest':
          if (path.length < 3) continue;
          const setting = path[2] as keyof TunnelOriginRequest;
          const parser = DockerService.originRequestParsers[setting];
          
          if (parser && config.originRequest) {
            config.originRequest[setting] = parser(value);
          }
          break;
      }
    }

    return dockerLabelConfigSchema.parse(config);
  }

  async shouldManageTunnel(container: CustomContainerInfo, previousState?: string): Promise<{
    shouldManage: boolean;
    config?: DockerTunnelConfig;
  }> {
    const labels = container.Labels || {};
    const config = this.parseDotNotationLabels(labels);

    if (!config.assign) {
      return { shouldManage: false };
    }

    const containerName = container.Names[0].replace("/", "");
    let hostname: string;
    
    if (config.hostname) {
      if (!config.hostname.endsWith(this.domain)) {
        hostname = `${config.hostname}.${this.domain}`;
        logger.warn({ originalHostname: config.hostname, newHostname: hostname }, 
          'Custom hostname did not include domain, appending domain');
      } else {
        hostname = config.hostname;
      }
    } else {
      hostname = `${containerName}.${this.domain}`;
    }

    const port = config.service?.port || container.Ports?.[0]?.PublicPort || 80;
    const protocol = config.service?.protocol || 'http';
    const path = config.service?.path || '';

    let service = `${protocol}://localhost:${port}`;
    if (path) {
      service += path.startsWith('/') ? path : `/${path}`;
    }

    if (previousState !== container.State && container.State === "running") {
      const tunnelConfig = dockerTunnelConfigSchema.parse({
        containerName,
        hostname,
        port,
        service,
        originRequest: config.originRequest
      });

      return {
        shouldManage: true,
        config: tunnelConfig
      };
    }

    return { shouldManage: false };
  }
}