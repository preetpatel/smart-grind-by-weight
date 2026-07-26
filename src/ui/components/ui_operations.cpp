#include "ui_operations.h"
#include <Arduino.h>
#include <memory>

void UIOperations::execute_tare(HardwareManager* hw_manager,
                                OperationCallback completion,
                                OperationCallback on_failure) {
    auto& overlay = BlockingOperationOverlay::getInstance();

    auto tare_succeeded = std::make_shared<bool>(false);
    auto tare_operation = [hw_manager, tare_succeeded]() {
        // This will now block and wait for settlement internally
        *tare_succeeded = hw_manager->get_load_cell()->tare();
        if (*tare_succeeded) {
            LOG_BLE("Scale tared successfully\n");
        } else {
            LOG_BLE("ERROR: Scale tare failed; keeping previous tare\n");
        }
    };

    auto tare_completion = [tare_succeeded, completion, on_failure]() {
        if (*tare_succeeded) {
            if (completion) {
                completion();
            }
        } else if (on_failure) {
            on_failure();
        }
    };

    overlay.show_and_execute(
        BlockingOperation::TARING,
        tare_operation,
        tare_completion);
}

void UIOperations::execute_calibration(HardwareManager* hw_manager, float cal_weight,
                                       OperationCallback completion,
                                       OperationCallback on_failure) {
    auto& overlay = BlockingOperationOverlay::getInstance();

    auto calibration_succeeded = std::make_shared<bool>(false);
    auto calibration_operation = [hw_manager, cal_weight, calibration_succeeded]() {
        // This will now block and wait for settlement internally
        *calibration_succeeded = hw_manager->get_load_cell()->calibrate(cal_weight);
        if (*calibration_succeeded) {
            LOG_BLE("Scale calibrated with %.2fg weight\n", cal_weight);
        } else {
            LOG_BLE("ERROR: Scale calibration failed; keeping previous calibration\n");
        }
    };

    auto calibration_completion = [calibration_succeeded, completion, on_failure]() {
        if (*calibration_succeeded) {
            if (completion) {
                completion();
            }
        } else if (on_failure) {
            on_failure();
        }
    };

    overlay.show_and_execute(
        BlockingOperation::CALIBRATING,
        calibration_operation,
        calibration_completion);
}

void UIOperations::execute_grind_tare(GrindController* grind_controller, OperationCallback completion) {
    // No blocking overlay needed - tare is now non-blocking in GrindController
    // The GrindController will handle the tare operation in its update loop
    grind_controller->user_tare_request();
    LOG_BLE("Grind tare initiated (non-blocking)\n");
    
    // Call completion callback immediately since we're not blocking
    if (completion) {
        completion();
    }
}

void UIOperations::execute_custom_operation(const char* message, 
                                           OperationCallback operation,
                                           OperationCallback completion) {
    auto& overlay = BlockingOperationOverlay::getInstance();
    overlay.show_and_execute(BlockingOperation::CUSTOM, operation, completion, message);
}
