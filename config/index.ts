import 'dotenv/config';

export interface GitHubConfig {
    appId: string;
    privateKeyPath: string;
    installationId: string;
}

export interface LoggingConfig {
    level: string;
}

export interface DatabaseConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
}

export interface GitFixConfig {
    github: GitHubConfig;
    logging: LoggingConfig;
    environment: string;
    database?: DatabaseConfig;
}

const config: GitFixConfig = {
    github: {
        appId: process.env.GH_APP_ID ?? '',
        privateKeyPath: process.env.GH_PRIVATE_KEY_PATH ?? '',
        installationId: process.env.GH_INSTALLATION_ID ?? '',
    },
    logging: {
        level: process.env.LOG_LEVEL ?? 'info',
    },
    environment: process.env.NODE_ENV ?? 'development',
};

export default config;

