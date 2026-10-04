package gr.poiedk.ps5webkit;

import android.content.Context;
import java.util.function.Consumer;

public class LocalHttpsServer {
    private final int port;
    private final Consumer<String> logger;
    private boolean running;

    public LocalHttpsServer(Context context, int port, Consumer<String> logger) {
        this.port = port;
        this.logger = logger;
    }

    public boolean isRunning() {
        return running;
    }

    public void start() {
        running = true;
        logger.accept("UI prototype active on configured port " + port + ".");
        logger.accept("Embedded network host is not included in this build.");
    }

    public void stop() {
        running = false;
    }
}
