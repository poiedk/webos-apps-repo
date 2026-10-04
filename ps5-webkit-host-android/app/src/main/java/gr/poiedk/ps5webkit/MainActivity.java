package gr.poiedk.ps5webkit;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.net.Inet4Address;
import java.net.NetworkInterface;
import java.util.Collections;

public class MainActivity extends Activity {
    private LocalHttpsServer server;
    private TextView status;
    private TextView logs;
    private EditText phoneIp;
    private EditText routerIp;
    private EditText targetIp;
    private EditText port;
    private Button startStop;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(28, 28, 28, 28);
        root.setBackgroundColor(0xFF07111E);

        TextView title = text("PS5 WebKit Host", 26, 0xFFFFFFFF);
        title.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(title);

        TextView subtitle = text("Local HTTPS host • Android", 14, 0xFF9DB7D3);
        subtitle.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(subtitle);

        status = text("STOPPED", 18, 0xFFFFC857);
        status.setPadding(0, 28, 0, 20);
        root.addView(status);

        phoneIp = field("Phone IP", findLanIp());
        routerIp = field("Router IP", "192.168.1.1");
        targetIp = field("Console / client IP", "");
        port = field("HTTPS port", "8443");
        port.setInputType(InputType.TYPE_CLASS_NUMBER);

        root.addView(phoneIp);
        root.addView(routerIp);
        root.addView(targetIp);
        root.addView(port);

        startStop = button("START HTTPS HOST");
        startStop.setOnClickListener(v -> toggleServer());
        root.addView(startStop);

        Button copy = button("COPY OPENWRT DNAT");
        copy.setOnClickListener(v -> copyOpenWrt());
        root.addView(copy);

        TextView logTitle = text("Logs", 16, 0xFFFFFFFF);
        logTitle.setPadding(0, 24, 0, 8);
        root.addView(logTitle);

        logs = text("Ready.\n", 12, 0xFFB8CBDD);
        logs.setTextIsSelectable(true);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(logs);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
        scroll.setLayoutParams(sp);
        root.addView(scroll);

        setContentView(root);
    }

    private TextView text(String s, int sp, int color) {
        TextView v = new TextView(this);
        v.setText(s);
        v.setTextSize(sp);
        v.setTextColor(color);
        return v;
    }

    private EditText field(String hint, String value) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setHintTextColor(0xFF71869B);
        e.setTextColor(0xFFFFFFFF);
        e.setSingleLine(true);
        e.setText(value);
        e.setPadding(12, 8, 12, 8);
        return e;
    }

    private Button button(String label) {
        Button b = new Button(this);
        b.setText(label);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        p.setMargins(0, 10, 0, 0);
        b.setLayoutParams(p);
        return b;
    }

    private void toggleServer() {
        if (server != null && server.isRunning()) {
            server.stop();
            status.setText("STOPPED");
            startStop.setText("START HTTPS HOST");
            log("Server stopped.");
            return;
        }

        int p;
        try {
            p = Integer.parseInt(port.getText().toString().trim());
        } catch (Exception e) {
            Toast.makeText(this, "Invalid port", Toast.LENGTH_SHORT).show();
            return;
        }

        try {
            server = new LocalHttpsServer(this, p, this::log);
            server.start();
            status.setText("RUNNING • https://" + phoneIp.getText().toString().trim() + ":" + p);
            startStop.setText("STOP HTTPS HOST");
            log("HTTPS server listening on TCP " + p);
        } catch (Exception e) {
            log("ERROR: " + e);
            Toast.makeText(this, "Could not start server", Toast.LENGTH_LONG).show();
        }
    }

    private void copyOpenWrt() {
        String phone = phoneIp.getText().toString().trim();
        String client = targetIp.getText().toString().trim();
        String p = port.getText().toString().trim();

        if (phone.isEmpty() || client.isEmpty()) {
            Toast.makeText(this, "Enter phone and client IP", Toast.LENGTH_SHORT).show();
            return;
        }

        String cmd =
                "uci add firewall redirect\n" +
                "uci set firewall.@redirect[-1].name='Android-HTTPS-Host'\n" +
                "uci set firewall.@redirect[-1].src='lan'\n" +
                "uci set firewall.@redirect[-1].src_ip='" + client + "'\n" +
                "uci set firewall.@redirect[-1].src_dport='443'\n" +
                "uci set firewall.@redirect[-1].proto='tcp'\n" +
                "uci set firewall.@redirect[-1].dest='lan'\n" +
                "uci set firewall.@redirect[-1].dest_ip='" + phone + "'\n" +
                "uci set firewall.@redirect[-1].dest_port='" + p + "'\n" +
                "uci set firewall.@redirect[-1].target='DNAT'\n" +
                "uci commit firewall\n" +
                "/etc/init.d/firewall restart\n";

        ClipboardManager cb = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        cb.setPrimaryClip(ClipData.newPlainText("OpenWrt DNAT", cmd));
        Toast.makeText(this, "OpenWrt commands copied", Toast.LENGTH_SHORT).show();
        log("Copied OpenWrt DNAT commands.");
    }

    private void log(String line) {
        runOnUiThread(() -> {
            logs.append(line + "\n");
        });
    }

    private String findLanIp() {
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                for (java.net.InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!a.isLoopbackAddress() && a instanceof Inet4Address && a.isSiteLocalAddress()) {
                        return a.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {}
        return "";
    }

    @Override
    protected void onDestroy() {
        if (server != null) server.stop();
        super.onDestroy();
    }
}
