-- =====================================================================
--  Upgrade an existing smart_emission_db for the web app.
--  Safe to run more than once. Does not delete any data.
-- =====================================================================
USE smart_emission_db;

-- 1. Race-safe PayFine (single atomic UPDATE instead of SELECT ... FOR UPDATE)
DROP PROCEDURE IF EXISTS PayFine;
DELIMITER $$
CREATE PROCEDURE PayFine(IN p_violation_id BIGINT)
BEGIN
    UPDATE Violations_Log
       SET status = 'Paid', paid_at = NOW()
     WHERE violation_id = p_violation_id
       AND status = 'Pending';

    IF ROW_COUNT() = 0 THEN
        IF EXISTS (SELECT 1 FROM Violations_Log WHERE violation_id = p_violation_id) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Fine already paid';
        ELSE
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Violation not found';
        END IF;
    END IF;
END$$
DELIMITER ;

-- 2. Sensor health view (recreated so it always matches the app)
CREATE OR REPLACE VIEW vw_sensor_health AS
SELECT s.sensor_id, s.mac_address, s.sensor_status, v.license_plate,
       MAX(t.recorded_at) AS last_reading, COUNT(t.log_id) AS total_readings
FROM IoT_Sensors s
JOIN Vehicles v            ON v.vehicle_id = s.vehicle_id
LEFT JOIN Telemetry_Logs t ON t.sensor_id  = s.sensor_id
GROUP BY s.sensor_id, s.mac_address, s.sensor_status, v.license_plate;

-- 3. Optional: a dedicated login for the web app instead of root.
--    Uncomment, choose a password, and put the same values in the .env file.
-- CREATE USER IF NOT EXISTS 'emission_app'@'localhost' IDENTIFIED BY 'change_me';
-- GRANT SELECT, INSERT, UPDATE, EXECUTE, INDEX ON smart_emission_db.* TO 'emission_app'@'localhost';
