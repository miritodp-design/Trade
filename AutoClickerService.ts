/**
 * AutoClickerService
 * High-level bridge between the React Native app and the native Android
 * AutoClicker module.  Falls back to simulation when the native module is not
 * available (Expo Go / web preview).
 */
import AutoClicker, {
  isNativeAvailable,
  OCRResult,
} from "@/modules/auto-clicker";
import { TickPoint, makeDecision, Signal } from "@/services/TradingBrain";

export interface ClickerSession {
  pair: string;
  amount: number;
  durationSecs: number;
  totalTrades: number;
}

export interface ClickerTradeEvent {
  signal: Signal;
  entryPrice: number;
}

export interface ClickerResultEvent {
  signal: Signal;
  entryPrice: number;
  exitPrice: number;
  result: "WIN" | "LOSS";
  profit: number;
}

// ─── Human-like delay ──────────────────────────────────────────────────────

export function humanDelay(minMs = 300, maxMs = 700): Promise<void> {
  return new Promise((r) =>
    setTimeout(r, minMs + Math.random() * (maxMs - minMs))
  );
}

// ─── Permission helpers ────────────────────────────────────────────────────

export function checkAllPermissions(): {
  accessibility: boolean;
  overlay: boolean;
  native: boolean;
} {
  return {
    native: isNativeAvailable(),
    accessibility: AutoClicker.isAccessibilityEnabled(),
    overlay: AutoClicker.isOverlayPermissionGranted(),
  };
}

// ─── Configure Pocket Option via UI automation ─────────────────────────────

export async function configurePocketOption(
  session: ClickerSession,
  onStatus: (msg: string) => void
): Promise<boolean> {
  if (!isNativeAvailable()) return false;

  // 1. Make sure Pocket Option is open
  onStatus("Verificando Pocket Option...");
  if (!AutoClicker.isPocketOptionRunning()) {
    onStatus("Abrindo Pocket Option...");
    AutoClicker.launchPocketOption();
    await new Promise((r) => setTimeout(r, 3000));
  }

  // 2. Capture screen and locate value field
  onStatus("Localizando campo de valor...");
  await humanDelay(500, 900);
  const screen1 = await AutoClicker.captureAndAnalyze();

  if (screen1?.valueFieldBounds) {
    onStatus(`Ajustando valor para R$${session.amount}...`);
    await AutoClicker.performTap(
      screen1.valueFieldBounds.x,
      screen1.valueFieldBounds.y
    );
    await humanDelay(400, 700);
    await AutoClicker.clearAndTypeInFocusedField(
      session.amount.toFixed(2)
    );
    await humanDelay(300, 600);
  } else {
    onStatus("Campo de valor não encontrado via OCR, continuando...");
  }

  // 3. Set expiry time using accessibility node search
  onStatus("Ajustando tempo de expiração...");
  await humanDelay(400, 700);
  const mins = Math.round(session.durationSecs / 60);
  const timeLabel =
    session.durationSecs < 60
      ? `${session.durationSecs}s`
      : `${mins}:00`;

  const tapped = await AutoClicker.findAndTapByText(timeLabel);
  if (!tapped) {
    // Try numeric search fallback
    await AutoClicker.findAndTapByText(mins.toString());
  }
  await humanDelay(400, 600);

  onStatus("Configuração concluída ✅");
  return true;
}

// ─── Execute a single trade ────────────────────────────────────────────────

export async function executeSingleTrade(
  ticks: TickPoint[],
  session: ClickerSession,
  onStatus: (msg: string) => void,
  onTrade: (event: ClickerTradeEvent) => void,
  onResult: (event: ClickerResultEvent) => void,
  stopFlag: () => boolean
): Promise<void> {
  if (stopFlag()) return;

  const decision = makeDecision(ticks);
  if (decision.signal === "NONE" || decision.agreementCount < 2) return;

  const screen = await AutoClicker.captureAndAnalyze();
  if (!screen || stopFlag()) return;

  const entryPrice = screen.price ?? ticks[ticks.length - 1]?.price ?? 0;

  onStatus(
    `Sinal: ${decision.signal} (${decision.agreementCount}/3 estratégias)`
  );
  onTrade({ signal: decision.signal, entryPrice });

  await humanDelay(300, 700);
  if (stopFlag()) return;

  // Tap CALL or PUT
  let tapped = false;
  if (decision.signal === "CALL") {
    const callBounds = screen.callButtonBounds;
    if (callBounds) {
      tapped = await AutoClicker.performTap(callBounds.x, callBounds.y);
    }
    if (!tapped) {
      tapped = await AutoClicker.findAndTapByText("CALL");
    }
    onStatus("Tocando CALL ↑...");
  } else {
    const putBounds = screen.putButtonBounds;
    if (putBounds) {
      tapped = await AutoClicker.performTap(putBounds.x, putBounds.y);
    }
    if (!tapped) {
      tapped = await AutoClicker.findAndTapByText("PUT");
    }
    onStatus("Tocando PUT ↓...");
  }

  if (!tapped) {
    onStatus("Botão não encontrado, aguardando próximo sinal...");
    return;
  }

  // Wait for expiry
  onStatus(
    `Operação aberta, aguardando ${session.durationSecs}s...`
  );
  await new Promise((r) => setTimeout(r, session.durationSecs * 1000));
  if (stopFlag()) return;

  // Read exit price
  const screen2 = await AutoClicker.captureAndAnalyze();
  const exitPrice = screen2?.price ?? entryPrice;
  const priceMove = exitPrice - entryPrice;

  let result: "WIN" | "LOSS";
  if (decision.signal === "CALL") {
    result = priceMove > 0 ? "WIN" : "LOSS";
  } else {
    result = priceMove < 0 ? "WIN" : "LOSS";
  }

  const profit = result === "WIN" ? session.amount * 0.85 : -session.amount;
  onResult({ signal: decision.signal, entryPrice, exitPrice, result, profit });
  onStatus(result === "WIN" ? `✅ WIN +R$${profit.toFixed(2)}` : `❌ LOSS -R$${session.amount.toFixed(2)}`);
}
