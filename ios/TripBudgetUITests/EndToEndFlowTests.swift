import XCTest

/// End-to-end verification of the MVP loop, driven through the real UI against a
/// real backend:
///
///   设置昵称 → 创建账本 → 分享邀请码 → 另一台设备加入 →
///   说一句话 → Agent 理解 → 确认分摊 → 保存 → 首页看到 → 统计正确
///
/// Screenshots are attached at each step, so a run doubles as visual evidence.
/// Requires the server on http://127.0.0.1:4000 (`npm run dev` in ../server).
final class EndToEndFlowTests: XCTestCase {
    private var app: XCUIApplication!
    private static let baseURL = "http://127.0.0.1:4000"

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-uitest-reset"]
        app.launchEnvironment["TRIP_BUDGET_API"] = Self.baseURL
        app.launch()
    }

    // MARK: - Helpers

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func tapWhenReady(
        _ element: XCUIElement,
        timeout: TimeInterval = 25,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(
            element.waitForExistence(timeout: timeout),
            "missing \(element)",
            file: file,
            line: line
        )
        element.tap()
    }

    private func typeInto(_ element: XCUIElement, _ text: String, timeout: TimeInterval = 25) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "missing text field")
        element.tap()
        element.typeText(text)
    }

    private func firstText(for identifier: String) -> XCUIElement {
        let view = app.textViews[identifier]
        return view.exists ? view : app.textFields[identifier]
    }

    private func allLabels() -> String {
        app.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: " | ")
    }

    private func readInviteCode() -> String? {
        let predicate = NSPredicate(format: "label MATCHES %@", "[A-Z0-9]{2,6}-[A-Z0-9]{5}")
        let element = app.staticTexts.containing(predicate).firstMatch
        guard element.waitForExistence(timeout: 25) else { return nil }
        return element.label
    }

    /// Exercises the *other device*: a second anonymous user joining with the
    /// invite code, straight through the API.
    ///
    /// Deliberately synchronous: an `async` XCTest method makes the UI
    /// automation session flaky, and this call is trivial.
    private func joinAsAnotherDevice(nickname: String, inviteCode: String) {
        let auth = post(
            "/auth/anonymous",
            body: ["deviceId": "uitest-\(nickname)-\(UUID().uuidString)", "nickname": nickname]
        )
        let token = auth["token"] as? String ?? ""
        _ = post("/ledgers/join", body: ["inviteCode": inviteCode], token: token)
    }

    @discardableResult
    private func post(
        _ path: String,
        body: [String: Any],
        token: String? = nil
    ) -> [String: Any] {
        guard let url = URL(string: Self.baseURL + path) else { return [:] }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        var result: [String: Any] = [:]
        let semaphore = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data {
                result = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            }
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 20)
        return result
    }

    // MARK: - Tests

    @MainActor
    func testFullCaptureFlowFromOnboardingToSavedExpense() throws {
        // 1. Onboarding — the only "account" step in this version.
        typeInto(app.textFields.firstMatch, "小林")
        capture("01-onboarding")
        tapWhenReady(app.buttons["开始使用"])

        XCTAssertTrue(app.buttons["home.capture"].waitForExistence(timeout: 25))
        capture("02-home-no-ledger")

        // 2. Create a ledger and read the invite code off the screen.
        tapWhenReady(app.tabBars.buttons["账本"])
        tapWhenReady(app.buttons["创建新账本"])
        typeInto(app.textFields.firstMatch, "日本旅行")
        tapWhenReady(app.buttons["创建"])
        XCTAssertTrue(app.staticTexts["邀请其他人"].waitForExistence(timeout: 25))
        let inviteCode = readInviteCode()
        XCTAssertNotNil(inviteCode, "邀请码没有显示")
        capture("03-invite-code")

        tapWhenReady(app.buttons["完成"])
        // The sheet must be gone before the tab bar accepts taps.
        XCTAssertTrue(app.buttons["创建新账本"].waitForExistence(timeout: 20))

        // 3. Two more people join with that code — the real multi-user path.
        // 3. Two more people join with that code — the real multi-user path.
        joinAsAnotherDevice(nickname: "小王", inviteCode: inviteCode!)
        joinAsAnotherDevice(nickname: "小李", inviteCode: inviteCode!)

        // 4. Relaunch: this is the "second device" view of the same ledger, and it
        //    proves startup sync pulls in members added elsewhere.
        app.terminate()
        app.launchArguments.removeAll()
        app.launch()
        XCTAssertTrue(app.buttons["home.capture"].waitForExistence(timeout: 30))
        let membersLabel = allLabels()
        XCTAssertTrue(membersLabel.contains("小王"), "members should sync on launch: \(membersLabel)")
        XCTAssertTrue(membersLabel.contains("小李"), "members should sync on launch: \(membersLabel)")
        capture("04-home-with-members")

        // 5. Speak the headline sentence (typed here — the Simulator has no
        //    speech recognition, and the app falls back to the same sentence).
        tapWhenReady(app.buttons["home.capture"])
        let input = firstText(for: "capture.input")
        typeInto(input, "我付了 500，我们三个人吃饭，其中小王和小李也要分摊")
        capture("05-utterance")
        tapWhenReady(app.buttons["capture.analyse"])

        // 6. Confirmation: payer, participants, and the exact rounding.
        let save = app.buttons["confirm.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 30), "agent did not return a draft")
        XCTAssertTrue(save.isEnabled, "确认记账 should be enabled once the split balances")
        capture("06-confirm-card")

        let card = allLabels()
        XCTAssertTrue(card.contains("166.67"), "expected 166.67 on the confirmation card: \(card)")
        XCTAssertTrue(card.contains("166.66"), "expected the remainder cent 166.66: \(card)")

        tapWhenReady(save)

        // 7. Back on the home screen with the expense recorded.
        XCTAssertTrue(app.buttons["home.capture"].waitForExistence(timeout: 25))
        let home = allLabels()
        XCTAssertTrue(home.contains("吃饭"), "the new expense should be on the home screen: \(home)")
        capture("07-home-with-expense")

        // 8. Statistics keep "paid" and "borne" apart.
        tapWhenReady(app.tabBars.buttons["统计"])
        XCTAssertTrue(app.staticTexts["实际支付"].waitForExistence(timeout: 30))
        capture("08-stats")
        let stats = allLabels()
        XCTAssertTrue(stats.contains("500.00"), "total expense should be ¥500: \(stats)")
        XCTAssertTrue(stats.contains("166.67"), "小王 should bear ¥166.67: \(stats)")
    }

    func testCreatesALedgerAndSeesTheInviteCode() throws {
        typeInto(app.textFields.firstMatch, "小王")
        tapWhenReady(app.buttons["开始使用"])
        tapWhenReady(app.tabBars.buttons["账本"])
        tapWhenReady(app.buttons["创建新账本"])
        typeInto(app.textFields.firstMatch, "家庭账本")
        tapWhenReady(app.buttons["创建"])

        XCTAssertNotNil(readInviteCode(), "邀请码没有显示")
        capture("invite-code")
    }
}
