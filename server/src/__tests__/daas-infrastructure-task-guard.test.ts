import { describe, expect, it, vi } from "vitest";
import {
  DAAS_INFRASTRUCTURE_TASK_DENIAL_MESSAGE,
  DAAS_MISSION_ID_CONTEXT_KEY,
  DAAS_MISSION_ROUTE_CONTEXT_KEY,
  DAAS_PAPERCLIP_MISSIONS_ROUTE,
} from "@paperclipai/shared";
import {
  detectDaasInfrastructureTaskIntent,
  guardDaasInfrastructureTaskDispatch,
  collectDaasInfrastructureTaskInstructionTexts,
  isDaasMissionRoutedContext,
  logDaasInfrastructureTaskDenial,
  stripDaasMissionProvenanceFromUntrustedContext,
} from "../services/daas-infrastructure-task-guard.js";

describe("detectDaasInfrastructureTaskIntent", () => {
  it("detects SSH / raw shell / secret / credential / provider-key intent", () => {
    expect(detectDaasInfrastructureTaskIntent("SSH into the prod host and restart nginx").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("ssh root@prod.example.com and restart nginx").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("ssh prod.example.com uptime").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("ssh prod uptime").signals).toContain("ssh.open");
    expect(detectDaasInfrastructureTaskIntent("ssh alice@prod uptime").signals).toContain("ssh.open");
    expect(detectDaasInfrastructureTaskIntent("ssh 10.0.0.12 uptime").signals).toContain("ssh.open");
    expect(detectDaasInfrastructureTaskIntent("ssh [2001:db8::1] uptime").signals).toContain("ssh.open");
    expect(detectDaasInfrastructureTaskIntent("scp ./dump.sql root@prod.example.com:/tmp/").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("scp ./dump.sql root@prod:/tmp/").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("sftp deploy@prod").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("Connect to prod with SSH").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("log into the production host and tail logs").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("connect to the production box and inspect nginx logs").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("log into staging host and restart nginx").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("access the staging VM and inspect logs").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("Connect to production and run uptime").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("Log in to prod and check disk usage").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("connect to server and run uptime").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("log into server and tail logs").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("access VM and restart nginx").signals).toContain(
      "ssh.open",
    );
    expect(
      detectDaasInfrastructureTaskIntent("Run a shell command on the database server").signals,
    ).toContain("shell.execute");
    expect(detectDaasInfrastructureTaskIntent("run command on remote machine").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("Open a terminal on prod and run uptime").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("Open a shell on prod").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("Use ssh to access prod").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("Use Secure Shell to access prod").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("Open a secure shell session to prod").signals).toContain(
      "ssh.open",
    );
    expect(detectDaasInfrastructureTaskIntent("Start a secure shell to production").signals).toContain(
      "ssh.open",
    );
    expect(
      detectDaasInfrastructureTaskIntent("Establish a Secure Shell connection to the production host").signals,
    ).toContain("ssh.open");
    expect(detectDaasInfrastructureTaskIntent("Run rm -rf /var/www on prod").signals).toContain(
      "shell.execute",
    );
    expect(
      detectDaasInfrastructureTaskIntent("Run chmod 777 /etc/passwd on the production server").signals,
    ).toContain("shell.execute");
    expect(detectDaasInfrastructureTaskIntent("tail logs on prod server").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("tail production logs").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("view logs on prod").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("inspect prod host").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("run uptime on the production server").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("execute uptime on prod").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("Run ls on prod").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("execute whoami on prod host").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("run cat /etc/passwd on server").signals).toContain(
      "shell.execute",
    );
    expect(
      detectDaasInfrastructureTaskIntent("Execute systemctl restart nginx on the server").signals,
    ).toContain("shell.execute");
    expect(detectDaasInfrastructureTaskIntent("Open the production database console").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("Read the secret value for the DB").signals).toContain(
      "secret.read",
    );
    expect(detectDaasInfrastructureTaskIntent("Read DATABASE_URL from env").signals).toContain(
      "secret.read",
    );
    expect(detectDaasInfrastructureTaskIntent("get DATABASE_URL").signals).toContain(
      "secret.read",
    );
    expect(detectDaasInfrastructureTaskIntent("show DATABASE_URL").signals).toContain(
      "secret.read",
    );
    expect(detectDaasInfrastructureTaskIntent("echo $DATABASE_URL").signals).toContain(
      "secret.read",
    );
    expect(detectDaasInfrastructureTaskIntent("display the env token").signals).toContain(
      "secret.read",
    );
    expect(detectDaasInfrastructureTaskIntent("Read env vars from production").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("print STRIPE_SECRET_KEY").signals).toContain(
      "secret.read",
    );
    expect(detectDaasInfrastructureTaskIntent("Get the production database password").signals).toContain(
      "secret.read",
    );
    expect(detectDaasInfrastructureTaskIntent("Retrieve the production database password").signals).toContain(
      "secret.read",
    );
    expect(
      detectDaasInfrastructureTaskIntent("Run aws secretsmanager get-secret-value for prod/db").signals,
    ).toContain("secret.read");
    expect(detectDaasInfrastructureTaskIntent("get DATABASE_URL from production").signals).toContain(
      "secret.read",
    );
    expect(detectDaasInfrastructureTaskIntent("cat ~/.ssh/id_rsa from the server").signals).toContain(
      "secret.read",
    );
    expect(
      detectDaasInfrastructureTaskIntent("Retrieve the credentials from the vault").signals,
    ).toContain("credential.read");
    expect(detectDaasInfrastructureTaskIntent("Fetch the AWS access keys").signals).toContain(
      "provider_key.read",
    );
    expect(
      detectDaasInfrastructureTaskIntent("Provision a new droplet for the cluster").signals,
    ).toContain("infra.provision");
    expect(detectDaasInfrastructureTaskIntent("Run kubectl delete pod in prod").signals).toContain(
      "infra.orchestration",
    );
    expect(detectDaasInfrastructureTaskIntent("kubectl get secrets in prod").signals).toContain(
      "infra.orchestration",
    );
    expect(detectDaasInfrastructureTaskIntent("kubectl get pods in prod").signals).toContain(
      "infra.orchestration",
    );
    expect(detectDaasInfrastructureTaskIntent("terraform apply the production cluster").signals).toContain(
      "infra.orchestration",
    );
    expect(detectDaasInfrastructureTaskIntent("Use AWS CLI to restart the EC2 instance").signals).toContain(
      "infra.orchestration",
    );
    expect(detectDaasInfrastructureTaskIntent("Reboot the production server").signals).toContain(
      "infra.orchestration",
    );
    expect(detectDaasInfrastructureTaskIntent("restart prod nginx").signals).toContain(
      "infra.orchestration",
    );
	    expect(detectDaasInfrastructureTaskIntent("Restart nginx in production").signals).toContain(
	      "infra.orchestration",
	    );
	    expect(detectDaasInfrastructureTaskIntent("Restart postgres").signals).toContain(
	      "infra.orchestration",
	    );
	    expect(detectDaasInfrastructureTaskIntent("Reboot web-01").signals).toContain(
	      "infra.orchestration",
	    );
	    expect(detectDaasInfrastructureTaskIntent("Run migration").signals).toContain(
	      "infra.orchestration",
	    );
	    expect(detectDaasInfrastructureTaskIntent("Rotate TLS certificate").signals).toContain(
	      "infra.orchestration",
	    );
	    expect(detectDaasInfrastructureTaskIntent("restart nginx on 10.0.0.5").signals).toContain(
	      "infra.orchestration",
	    );
    expect(detectDaasInfrastructureTaskIntent("reload redis on app-01.internal").signals).toContain(
      "infra.orchestration",
    );
    expect(detectDaasInfrastructureTaskIntent("restart service on 10.0.0.0/24").signals).toContain(
      "infra.orchestration",
    );
    expect(detectDaasInfrastructureTaskIntent("run uptime on 10.0.0.5").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("tail logs from api.internal.example").signals).toContain(
      "shell.execute",
    );
    expect(detectDaasInfrastructureTaskIntent("Restart the server").signals).toContain(
      "infra.orchestration",
    );
    expect(detectDaasInfrastructureTaskIntent("Restart the production database").signals).toContain(
      "infra.orchestration",
    );
    expect(detectDaasInfrastructureTaskIntent("Rotate the prod TLS certificate").signals).toContain(
      "infra.orchestration",
    );
    expect(detectDaasInfrastructureTaskIntent("Deploy to production using kubectl").signals).toContain(
      "infra.orchestration",
    );
    for (const text of [
      "Deploy the current release to production",
      "Deploy to prod",
      "Promote latest image to production",
      "Rollback production deploy",
      "Roll back the last deployment in prod",
      "Run the production database migration",
      "Backup the staging database",
      "Restore the production backup",
    ]) {
      expect(detectDaasInfrastructureTaskIntent(text).signals).toContain("infra.orchestration");
    }
  });

  it("does not flag ordinary product/engineering tasks", () => {
    for (const text of [
      "Write a blog post about our launch",
      "Fix the pagination bug on the dashboard",
      "Refactor the issue list component",
      "Add unit tests for the pricing calculator",
      "Document why example 10.0.0.5 appears in setup screenshots",
    ]) {
      expect(detectDaasInfrastructureTaskIntent(text).isInfrastructureIntent).toBe(false);
    }
  });

  it("combines multiple text sources (title/description/reason)", () => {
    const result = detectDaasInfrastructureTaskIntent(
      "Investigate latency",
      "We may need to ssh into the box",
      null,
    );
    expect(result.isInfrastructureIntent).toBe(true);
    expect(result.signals).toContain("ssh.open");
  });

  it("detects plugin wake payload prompts as dispatch instructions", () => {
    const texts = collectDaasInfrastructureTaskInstructionTexts({
      payload: { prompt: "ssh into prod and print DATABASE_URL from env" },
      contextSnapshot: {},
      reason: "agents.invoke",
    });
    const result = detectDaasInfrastructureTaskIntent(...texts);
    expect(result.isInfrastructureIntent).toBe(true);
    expect(result.signals).toContain("ssh.open");
    expect(result.signals).toContain("secret.read");
  });
});

describe("guardDaasInfrastructureTaskDispatch", () => {
  it("allows non-infrastructure tasks regardless of routing or adapter", () => {
    const result = guardDaasInfrastructureTaskDispatch({
      title: "Update marketing copy",
    });
    expect(result.allowed).toBe(true);
    expect(result.decision).toBe("allow_non_infrastructure");
    expect(result.message).toBeNull();
  });

  it("blocks the T020 bypass path: infra task dispatched directly (not via mission API)", () => {
    const result = guardDaasInfrastructureTaskDispatch({
      title: "SSH into the prod server and rotate the secret",
    });
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe("deny_requires_mission_route");
    expect(result.message).toBe(DAAS_INFRASTRUCTURE_TASK_DENIAL_MESSAGE);
    expect(result.missionRoute).toBe(DAAS_PAPERCLIP_MISSIONS_ROUTE);
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it("blocks infra task execution in heartbeat even when mission-routed", () => {
    const result = guardDaasInfrastructureTaskDispatch({
      title: "SSH into the prod server",
    });
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe("deny_requires_mission_route");
  });

  it("blocks infra task instructions carried only by wake payload prompt", () => {
    const result = guardDaasInfrastructureTaskDispatch({
      reason: "agents.invoke",
      instructionTexts: collectDaasInfrastructureTaskInstructionTexts({
        payload: { prompt: "Run kubectl delete pod in prod" },
        contextSnapshot: {},
        reason: "agents.invoke",
      }),
    });
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe("deny_requires_mission_route");
    expect(result.signals).toContain("infra.orchestration");
  });

  it("fails closed for production resource operation wording", () => {
    for (const title of [
      "Restart the production database",
      "Rotate the prod TLS certificate",
      "Open the production database console",
      "Run rm -rf /var/www on prod",
      "Run chmod 777 /etc/passwd on the production server",
      "Open a shell on prod",
      "Use ssh to access prod",
      "Use Secure Shell to access prod",
      "Open a secure shell session to prod",
      "Start a secure shell to production",
      "Establish a Secure Shell connection to the production host",
      "log into staging host and restart nginx",
      "access the staging VM and inspect logs",
      "Connect to production and run uptime",
      "Log in to prod and check disk usage",
      "connect to server and run uptime",
      "log into server and tail logs",
      "run command on remote machine",
      "access VM and restart nginx",
	      "Read env vars from production",
	      "Restart nginx in production",
	      "Restart postgres",
	      "Reboot web-01",
	      "Run migration",
	      "Rotate TLS certificate",
	      "Restart the server",
      "Get the production database password",
      "Retrieve the production database password",
      "tail production logs",
      "view logs on prod",
      "scp ./dump.sql root@prod:/tmp/",
      "sftp deploy@prod",
      "Deploy the current release to production",
      "Deploy to prod",
      "Promote latest image to production",
      "Rollback production deploy",
      "Roll back the last deployment in prod",
      "Run the production database migration",
      "Backup the staging database",
      "Restore the production backup",
      "restart nginx on 10.0.0.5",
      "reload redis on app-01.internal",
      "restart service on 10.0.0.0/24",
      "run uptime on 10.0.0.5",
      "tail logs from api.internal.example",
    ]) {
      expect(guardDaasInfrastructureTaskDispatch({ title })).toMatchObject({
        allowed: false,
        decision: "deny_requires_mission_route",
      });
    }
  });
});

describe("isDaasMissionRoutedContext", () => {
  it("recognizes mission provenance without treating it as execution authorization", () => {
    expect(
      isDaasMissionRoutedContext({
        [DAAS_MISSION_ROUTE_CONTEXT_KEY]: {
          route: DAAS_PAPERCLIP_MISSIONS_ROUTE,
          [DAAS_MISSION_ID_CONTEXT_KEY]: "mission-1",
        },
      }),
    ).toBe(true);
    expect(isDaasMissionRoutedContext({ [DAAS_MISSION_ROUTE_CONTEXT_KEY]: true })).toBe(false);
    expect(isDaasMissionRoutedContext({ [DAAS_MISSION_ROUTE_CONTEXT_KEY]: "true" })).toBe(false);
    expect(isDaasMissionRoutedContext({
      [DAAS_MISSION_ROUTE_CONTEXT_KEY]: {
        route: "/api/other",
        [DAAS_MISSION_ID_CONTEXT_KEY]: "mission-1",
      },
    })).toBe(false);
    expect(isDaasMissionRoutedContext({})).toBe(false);
    expect(isDaasMissionRoutedContext(null)).toBe(false);
    expect(isDaasMissionRoutedContext(undefined)).toBe(false);
  });

  it("strips forged DAAS route provenance from untrusted context", () => {
    const context = {
      issueId: "issue-1",
      [DAAS_MISSION_ID_CONTEXT_KEY]: "mission-1",
      [DAAS_MISSION_ROUTE_CONTEXT_KEY]: {
        route: DAAS_PAPERCLIP_MISSIONS_ROUTE,
        [DAAS_MISSION_ID_CONTEXT_KEY]: "mission-1",
      },
    };
    stripDaasMissionProvenanceFromUntrustedContext(context);
    expect(context).toEqual({ issueId: "issue-1" });
  });
});

describe("logDaasInfrastructureTaskDenial", () => {
  it("logs the denial without any secret material from the task text", () => {
    const warn = vi.fn();
    const sensitiveTaskText =
      "SSH into prod with placeholder credential material and read a provider key";
    const result = guardDaasInfrastructureTaskDispatch({
      title: sensitiveTaskText,
    });
    expect(result.allowed).toBe(false);

    logDaasInfrastructureTaskDenial(
      { warn },
      {
        result,
        context: { companyId: "c1", agentId: "a1", issueId: "i1", source: "assignment" },
      },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const [payload, message] = warn.mock.calls[0];
    const serialized = JSON.stringify({ payload, message });
    expect(serialized).not.toContain("placeholder credential material");
    expect(serialized).not.toContain("provider key");
    expect(serialized).not.toContain("SSH into prod");
    // Only safe, structured fields are logged.
    expect(payload).toMatchObject({
      event: "daas.infrastructure_task.denied",
      decision: "deny_requires_mission_route",
      signals: result.signals,
      companyId: "c1",
      agentId: "a1",
      issueId: "i1",
      source: "assignment",
    });
  });
});
