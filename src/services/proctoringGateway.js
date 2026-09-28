const WebSocket = require("ws");
const { verifyAccessToken } = require("../config/jwt");
const repo = require("../data");

const { fraudAiWsUrl } = require("../config/env");

const FRAUD_AI_WS_URL =
  fraudAiWsUrl ||
  "wss://edusaas-aiml-parb.onrender.com/ws/proctor";

const activeSessions = new Map();

function sendJson(socket, data) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(data));
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

async function validateProctoringStart(message) {
  const { access_token, session_id } = message;

  if (!access_token) {
    const error = new Error("Missing access token.");
    error.code = "AUTH_REQUIRED";
    throw error;
  }

  if (!session_id) {
    const error = new Error("Missing assessment session ID.");
    error.code = "SESSION_ID_REQUIRED";
    throw error;
  }

  let decoded;

  try {
    decoded = verifyAccessToken(access_token);
  } catch {
    const error = new Error(
      "Invalid or expired access token."
    );

    error.code = "INVALID_TOKEN";

    throw error;
  }

  const userId = decoded.sub;

  if (!userId) {
    const error = new Error(
      "Authenticated user ID is missing."
    );

    error.code = "INVALID_TOKEN";

    throw error;
  }

  const sessionId = Number(session_id);
  const assessmentype = String (message.assessment_type || "QUIZ").toUpperCase();

  if (!Number.isInteger(sessionId)) {
    const error = new Error(
      "Invalid assessment session ID."
    );

    error.code = "INVALID_SESSION_ID";

    throw error;
  }

  /*
  * IMPORTANT:
  *
  * Node verifies that this assessment session actually
  * belongs to the authenticated user.
  *
  * QUIZ    -> quizSessions
  * CODING  -> codingSessions
  */
  const assessmentType = String(
    message.assessment_type || "QUIZ"
  ).toUpperCase();

  let session;

  if (assessmentType === "CODING") {
    session =
      await repo.codingSessions.findBySessionAndUser(
        sessionId,
        userId
      );
  } else {
    session =
      await repo.quizSessions.findById(sessionId);
  }

  if (!session) {
    const error = new Error(
      "Assessment session not found."
    );

    error.code = "SESSION_NOT_FOUND";

    throw error;
  }

  if (String(session.user_id) !== String(userId)) {
    const error = new Error(
      "Assessment session does not belong to this user."
    );

    error.code = "SESSION_FORBIDDEN";

    throw error;
  }

  if (session.status !== "In Progress") {
    const error = new Error(
      `Assessment session is not active. Current status: ${session.status}`
    );

    error.code = "SESSION_NOT_ACTIVE";

    throw error;
  }

  return {
    userId,
    sessionId,
    session,
    assessmentType,
  };
}

function connectToFraudAI() {
  return new Promise((resolve, reject) => {
    const aiSocket = new WebSocket(
      FRAUD_AI_WS_URL
    );

    const timeout = setTimeout(() => {
      aiSocket.terminate();

      const error = new Error(
        "Fraud AI connection timeout."
      );

      error.code = "AI_CONNECTION_TIMEOUT";

      reject(error);
    }, 45000);

    aiSocket.once("open", () => {
      clearTimeout(timeout);
      resolve(aiSocket);
    });

    aiSocket.once("error", (error) => {
      clearTimeout(timeout);

      const wrappedError = new Error(
        `Unable to connect to fraud AI: ${error.message}`
      );

      wrappedError.code =
        "AI_CONNECTION_FAILED";

      reject(wrappedError);
    });
  });
}

async function persistProctoringEvent(
  sessionId,
  fraud,
  rawResult = null,
  assessmentType = "QUIZ"
) {
  if (!sessionId || !fraud) {
    return null;
  }

  try {
    if (assessmentType === "CODING") {
      console.log("[proctoring] Coding proctoring event:", {
        session_id: sessionId,
        violation_type: fraud.violation_type,
        action: fraud.action,
      });
      return { session_id: sessionId, ...fraud };
    }

    const event = await repo.proctoringEvents.create({
      session_id: sessionId,

      event_source:
        fraud.event_source || "AI",

      violation_type:
        fraud.violation_type || "UNKNOWN_VIOLATION",

      action:
        fraud.action || "WARNING",

      severity:
        fraud.severity || null,

      message:
        fraud.message || null,

      metadata: rawResult
        ? {
            timestamp: rawResult.timestamp ?? null,
            fraud,
          }
        : {
            fraud,
          },
    });

    console.log(
      "[proctoring] Fraud event persisted",
      {
        session_id: sessionId,
        event_id: event.event_id,
        event_source: event.event_source,
        violation_type: event.violation_type,
        action: event.action,
        raw_type: rawResult?.type ?? null,
        raw_fraud: rawResult?.fraud ?? null,
      }
    );

    return event;
  } catch (err) {
    console.warn("[proctoring] Could not persist proctoring event:", err.message);
    return null;
  }
}

async function terminateQuizSession(sessionId){
  if(!sessionId){
    return null;
  }
  const updatedSession = await repo.quizSessions.update(
    sessionId,
    {
      status: "Terminated",
      end_time: new Date(),
    }
  )
  console.log(`[proctoring] Quiz session ${sessionId} marked Terminated.`);
  return updatedSession
}

async function terminateAssessmentSession(sessionId, assessmentType = "QUIZ") {
  if (!sessionId) {
    return null;
  }
  if (assessmentType === "CODING") {
    try {
      const updated = await repo.codingSessions.update(sessionId, {
        status: "Terminated",
      });
      console.log(`[proctoring] Coding session ${sessionId} marked Terminated.`);
      return updated;
    } catch (err) {
      console.error(`[proctoring] Failed to mark coding session ${sessionId} Terminated:`, err.message);
      return null;
    }
  }
  return terminateQuizSession(sessionId);
}

function attachProctoringGateway(server) {
  /*
   * IMPORTANT:
   *
   * This attaches WebSocket handling to the EXISTING
   * Express HTTP server.
   *
   * Express remains completely untouched.
   */
  const wss = new WebSocket.Server({
    server,
    path: "/ws/proctor",

    /*
     * Camera frames are Base64 JPEG payloads.
     * Keep a reasonable upper limit.
     */
    maxPayload: 2 * 1024 * 1024,
  });

  wss.on("connection", (clientSocket) => {
    console.log(
      "[proctoring] Client WebSocket connected."
    );

    let authenticated = false;
    let sessionId = null;
    let userId = null;
    let assessmentType = "QUIZ";
    let aiSocket = null;

    // True when Python intentionally terminated the exam.
    // Prevents the subsequent AI WebSocket close from being
    // incorrectly reported as an AI failure.
    let examTerminated = false;
    let terminationEventPersisted = false;
    let terminationEventPromise = null;


    clientSocket.on(
      "message",
      async (rawMessage) => {
        const message = parseMessage(rawMessage);

        if (
          !message ||
          typeof message.type !== "string"
        ) {
          sendJson(clientSocket, {
            type: "PROCTORING_ERROR",
            code: "INVALID_MESSAGE",
            message:
              "Invalid WebSocket message.",
          });

          return;
        }

        /*
         * ==============================================
         * FIRST MESSAGE
         * ==============================================
         *
         * React must authenticate before anything
         * can be forwarded to Python.
         */
        if (!authenticated) {
          if (
            message.type !==
            "START_PROCTORING"
          ) {
            sendJson(clientSocket, {
              type: "PROCTORING_ERROR",
              code: "AUTH_REQUIRED",
              message:
                "First message must be START_PROCTORING.",
            });

            clientSocket.close(
              1008,
              "Authentication required"
            );

            return;
          }

          try {
            const auth =
              await validateProctoringStart(
                message
              );

            userId = auth.userId;
            sessionId = auth.sessionId;
            assessmentType = auth.assessmentType || "QUIZ";

            /*
             * Prevent duplicate active proctoring
             * connections for the same assessment
             * inside this Node process.
             */
            const existing = activeSessions.get(sessionId);
            if (existing) {
              sendJson(clientSocket, {
                type: "PROCTORING_ERROR",
                code: "PROCTORING_ALREADY_ACTIVE",
                message:
                  "Proctoring is already active for this assessment.",
              });

              clientSocket.close(
                1008,
                "Proctoring already active"
              );

              return;
            }

            /*
            * Reserve the session BEFORE connecting to AI.
            *
            * This prevents two concurrent WebSocket connections
            * from passing the active-session check.
            */
            activeSessions.set(sessionId, {
              clientSocket,
              aiSocket: null,
              userId,
              connecting: true,
            });

            /*
             * Connect MAIN NODE → PYTHON AI
             */
            aiSocket = await connectToFraudAI();
            authenticated = true;
            activeSessions.set(sessionId, {
              clientSocket,
              aiSocket,
              userId,
              connecting: false,
            });

            /*
             * Python's existing protocol.
             *
             * We do NOT modify Python.
             */
            aiSocket.send(
              JSON.stringify({
                type: "START_EXAM",
              })
            );

            /*
             * ==========================================
             * PYTHON → NODE → REACT
             * ==========================================
             */
            aiSocket.on(
              "message",
              async (rawAiMessage) => {
                if (
                  clientSocket.readyState !==
                  WebSocket.OPEN
                ) {
                  return;
                }

                const aiMessage = parseMessage(rawAiMessage);

                /*
                * If Python sent something that is not valid JSON,
                * don't let the gateway crash.
                *
                * Forward it unchanged for compatibility.
                */
                if (
                  !aiMessage ||
                  typeof aiMessage.type !== "string"
                ) {
                  clientSocket.send(rawAiMessage);
                  return;
                }

                try {
                  /*
                  * ==========================================
                  * PROCTORING RESULT
                  * ==========================================
                  */

                  if (
                    aiMessage.type ===
                    "PROCTORING_RESULT"
                  ) {
                    const fraud = aiMessage.fraud;

                    console.log(
                      "[proctoring] AI PROCTORING_RESULT",
                      {
                        session_id: sessionId,
                        violation_type:
                          fraud?.violation_type ?? null,
                        action:
                          fraud?.action ?? null,
                        event_source:
                          fraud?.event_source ?? null,
                        new_violation:
                          fraud?.new_violation ?? null,
                        violation_count:
                          fraud?.violation_count ?? null,
                      }
                    );

                    /*
                    * NORMAL result:
                    *
                    * Do not write normal AI frames to PostgreSQL.
                    */
                    if (
                      !fraud ||
                      fraud.new_violation !== true
                    ) {
                      clientSocket.send(
                        JSON.stringify(aiMessage)
                      );

                      return;
                    }

                    /*
                    * Persist the actual fraud violation.
                    */
                    if (fraud.action === "TERMINATE_EXAM") {
                      /*
                       * IMPORTANT:
                       *
                       * EXAM_TERMINATED can arrive before the async
                       * database insert above has completed.
                       *
                       * Store the persistence operation itself so the
                       * EXAM_TERMINATED handler can await the same
                       * operation.
                       */
                      terminationEventPromise = persistProctoringEvent(
                        sessionId,
                        fraud,
                        aiMessage,
                        assessmentType
                      );

                      try {
                        await terminationEventPromise;

                        terminationEventPersisted = true;
                      } catch (error) {
                        /*
                        * Clear the promise so a later retry/fallback
                        * can still be considered.
                        */
                        terminationEventPromise = null;

                        throw error;
                      }
                      // The terminating AI decision is authoritative.
                      // Do not wait for EXAM_TERMINATED because the
                      // browser may close the WebSocket immediately.
                      await terminateAssessmentSession(sessionId, assessmentType);

                      examTerminated = true;
                    } else {
                      await persistProctoringEvent(
                        sessionId,
                        fraud,
                        aiMessage,
                        assessmentType
                      );
                    }

                    /*
                    * Forward the original AI result to React.
                    */
                    clientSocket.send(
                      JSON.stringify(aiMessage)
                    );

                    return;
                  }

                  /*
                  * ==========================================
                  * EXAM TERMINATED
                  * ==========================================
                  */

                  if (
                    aiMessage.type ===
                    "EXAM_TERMINATED"
                  ) {

                    console.log(
                      "[proctoring] AI EXAM_TERMINATED",
                      {
                        session_id: sessionId,
                        violation_type:
                          aiMessage.violation_type ?? null,
                        action:
                          aiMessage.action ?? null,
                        event_source:
                          aiMessage.event_source ?? null,
                        violation_count:
                          aiMessage.violation_count ?? null,
                        terminationEventPersisted,
                      }
                    );
                    examTerminated = true;

                    /*
                    * If a terminating PROCTORING_RESULT is already
                    * being persisted, wait for THAT exact operation.
                    */
                    if (terminationEventPromise) {
                      try {
                        await terminationEventPromise;
                      } catch (error) {
                        console.error(
                          "[proctoring] Termination event persistence failed:",
                          error
                        );
                      }
                    }

                    /*
                    * If the terminating violation was successfully
                    * persisted, DO NOT create another event.
                    */
                    if (terminationEventPersisted) {
                      console.log(
                        `[proctoring] Termination event already persisted. ` +
                          `Skipping duplicate EXAM_TERMINATED event. ` +
                          `session=${sessionId}`
                      );
                    } else if (!terminationEventPromise) {
                      /*
                      * Python may theoretically send EXAM_TERMINATED
                      * without a preceding terminating PROCTORING_RESULT.
                      *
                      * Only in that case do we create a fallback event.
                      */
                      await persistProctoringEvent(
                        sessionId,
                        {
                          event_source: "AI",

                          violation_type:
                            aiMessage.violation_type ||
                            "EXAM_TERMINATED",

                          action:
                            aiMessage.action ||
                            "TERMINATE_EXAM",

                          severity:
                            aiMessage.severity ||
                            null,

                          message:
                            aiMessage.reason ||
                            aiMessage.message ||
                            "Assessment terminated by fraud detection AI.",
                        },
                        aiMessage,
                        assessmentType
                      );

                      terminationEventPersisted = true;
                    }

                    /*
                    * Mark Quiz/Coding Session as terminated.
                    */
                    await terminateAssessmentSession(
                      sessionId,
                      assessmentType
                    );

                    /*
                    * Tell React that the assessment has terminated.
                    */
                    clientSocket.send(
                      JSON.stringify(aiMessage)
                    );

                    return;
                  }

                  /*
                  * ==========================================
                  * PROCTORING STARTED / STOPPED / OTHER
                  * ==========================================
                  *
                  * These are control messages.
                  * They do not represent fraud events.
                  */
                  clientSocket.send(
                    JSON.stringify(aiMessage)
                  );
                } catch (error) {
                  console.error(
                    "[proctoring] Failed to process AI message:",
                    error
                  );

                  /*
                  * Important:
                  * Don't kill the WebSocket merely because
                  * persistence failed.
                  *
                  * React should still receive the AI result.
                  */
                  clientSocket.send(
                    JSON.stringify(aiMessage)
                  );

                  sendJson(clientSocket, {
                    type: "PROCTORING_ERROR",
                    code: "PROCTORING_PERSISTENCE_FAILED",
                    message:
                      "Proctoring event could not be persisted.",
                  });
                }
              }
            );

            aiSocket.on(
              "error",
              (error) => {
                console.error(
                  "[proctoring] Python AI error:",
                  error.message
                );
              }
            );

            aiSocket.on(
              "close",
              (closeCode, closeReason) => {
                console.log(
                  `[proctoring] Python AI connection closed. code=${closeCode} reason=${closeReason?.toString()}`
                );

                /*
                * If Python intentionally terminated the exam,
                * its WebSocket closing is expected.
                *
                * Do NOT report this as an AI failure.
                */
                if (examTerminated) {
                  console.log(
                    `[proctoring] AI connection closed normally after exam termination. session=${sessionId}`
                  );

                  return;
                }

                /*
                * Otherwise the AI connection disappeared
                * unexpectedly (e.g. Render spin-down or restart).
                *
                * Notify client but DO NOT kill the client WebSocket
                * or abort the student's exam. The exam remains active.
                */
                if (
                  clientSocket.readyState ===
                  WebSocket.OPEN
                ) {
                  sendJson(clientSocket, {
                    type:
                      "PROCTORING_WARNING",

                    code:
                      "AI_CONNECTION_CLOSED",

                    message:
                      "Fraud detection AI service is temporarily reconnecting. Your exam is active.",
                  });
                }
              }
            );

            return;
          } catch (error) {
            console.error(
              "[proctoring] Start failed:",
              error
            );

            sendJson(clientSocket, {
              type:
                "PROCTORING_ERROR",

              code:
                error.code ||
                "PROCTORING_START_FAILED",

              message:
                error.message ||
                "Unable to start proctoring.",
            });

            clientSocket.close(
              1008,
              "Unable to start proctoring"
            );

            return;
          }
        }

        /*
         * ==============================================
         * REACT → NODE → PYTHON
         * ==============================================
         */

        if (
          !aiSocket ||
          aiSocket.readyState !==
            WebSocket.OPEN
        ) {
          if (message.type === "VIDEO_FRAME") {
            // Silently drop video frame while AI is reconnecting/unavailable
            return;
          }

          sendJson(clientSocket, {
            type:
              "PROCTORING_WARNING",

            code:
              "AI_NOT_CONNECTED",

            message:
              "Fraud detection AI is not connected.",
          });

          return;
        }

        const allowedTypes =
          new Set([
            "VIDEO_FRAME",
            "BROWSER_VIOLATION",
            "STOP_EXAM",
          ]);

        if (
          !allowedTypes.has(
            message.type
          )
        ) {
          sendJson(clientSocket, {
            type:
              "PROCTORING_ERROR",

            code:
              "UNSUPPORTED_MESSAGE_TYPE",

            message:
              `Unsupported message type: ${message.type}`,
          });

          return;
        }

        /*
         * We deliberately do not modify the message.
         *
         * Node is acting as the authenticated gateway.
         */
        aiSocket.send(
          JSON.stringify(message)
        );
      }
    );

    clientSocket.on(
      "close",
      () => {
        console.log(
          "[proctoring] Client WebSocket closed."
        );

        if (sessionId !== null) {
          const active =
            activeSessions.get(
              sessionId
            );

          /*
           * Don't delete a newer connection
           * accidentally.
           */
          if (
            active?.clientSocket ===
            clientSocket
          ) {
            activeSessions.delete(
              sessionId
            );
          }
        }

        if (aiSocket) {
         try{
          aiSocket.close()
         }catch{}
        }
      }
    );

    clientSocket.on(
      "error",
      (error) => {
        console.error(
          "[proctoring] Client WebSocket error:",
          error.message
        );
      }
    );
  });

  console.log(
    "[proctoring] WebSocket endpoint available at /ws/proctor"
  );

  return wss;
}

module.exports = {
  attachProctoringGateway,
};